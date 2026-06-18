// server.js
// ==============================================================================
// RAiM 中継サーバー：マルチモーダル対応版
// ==============================================================================
//
// 【このファイルの役割】
// Flutter からの WebSocket 接続を受け、テキスト+画像の入力を処理して
// シーン判定 → 履歴取得 → プロンプト組立 → LLM 推論 → 応答返却 を統括する。
//
// 【マルチモーダル対応の変更点】
// - Flutter から { text, images: [{data, media_type}], session_id } を受信
// - images.data（Base64）を抽出して pickScene と buildMessages に渡す
// - 応答 JSON の image_description（内部用）を履歴記録時に活用
// - Flutter には image_description を送らない（types.js の normalizeLLMOutput で除去）
// - ログに images=N / hasImage=true を出力
//
// 【処理フロー】
//   [Flutter] ─ ws.send({text, images, session_id}) ──→ [server.js]
//                                                          │
//                                                          ├ images の Base64 を取り出し
//                                                          │
//                                                          ├ pickScene(text, {images})
//                                                          │   → hasImage バイアス補正でシーン判定
//                                                          │
//                                                          ├ memoryStore.listEvents() ← 並列
//                                                          │
//                                                          ├ buildMessages(scene, text, history, imageData)
//                                                          │   → Ollama 形式の images 添付
//                                                          │
//                                                          ├ callLLM(messages) ← Gemma 3 マルチモーダル推論
//                                                          │   → JSON 応答（image_description 含む）
//                                                          │
//                                                          ├ normalizeLLMOutput で image_description 抽出
//                                                          │
//                                                          ├ memoryStore.createEvent()
//                                                          │   ユーザー発言に [画像: 説明文] を埋め込んで記録
//                                                          │
//                                                          └ chat メッセージを Flutter へ送信（image_description 除く）

// ==============================================================================
// RAiM 中継サーバー：ストリーミング応答対応版
// ==============================================================================
//
// 【v5 での変更点】
// - 応答を 3 段階で送信:
//   1. metadata (即時、emotion / intensity 先送り) → Unity 表情切替・TTS準備
//   2. text_chunk (LLM 推論進行中、句読点ごと) → UI 表示・TTS 順次合成
//   3. chat_end (LLM 推論完了) → TTS キュー完了
// - LLM はストリーミング呼出 (callLLMStream) を使用
// - StreamingTextExtractor で text フィールドの値だけ抽出
//
// 【ユーザー体験の改善】
// 旧: ユーザー送信 → 5〜10秒待ち → 全文一括表示・音声再生
// 新: ユーザー送信 → 即時 emotion 反映 → 1〜2秒で喋り始め → 順次表示・音声
//
// 【v6 での変更点】
// - RAIM_STREAMING 環境変数でストリーミング ON/OFF を切替可能に
//   - true (デフォルト): ストリーミング応答 (metadata + text_chunk + chat_end)
//   - false: 従来の一括 chat 応答（旧クライアント互換）
// - 旧クライアントでテストしたい時は .env で RAIM_STREAMING=false にする
//
// 【処理の分岐ポイント】
// ストリーミング ON  → handleStreaming() で 3 段階送信
// ストリーミング OFF → handleNonStreaming() で chat メッセージ 1 個送信

// 【v7 での変更点】
// - 起動ログとリクエストログに現在時刻を表示
// - 動作中の「ライムがどの時間帯として認識してるか」をログで追える
// - 機能的な変更は prompt-builder.js に集約、server.js は表示のみ
//
// 【既存のストリーミング切替機能は維持】
// RAIM_STREAMING=true (デフォルト): 3段階送信
// RAIM_STREAMING=false: 従来の chat 一括応答

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { callLLM, callLLMStream } = require('./lib/llm');
const { buildMessages, getTimeContext } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');
const {
  MemoryStore,
  Role,
  eventsToMessages,
  buildUserContentWithImage,
} = require('./lib/memory-store');
const { StreamingTextExtractor } = require('./lib/streaming-parser');
const {
  EMOTIONS,
  ERROR_CODES,
  createFiller,
  createError,
  createSessionStart,
  createMetadata,
  createTextChunk,
  createChatEnd,
  normalizeLLMOutput,
  validateUpstream,
} = require('./lib/types');

// ─────────────────────────────────────────────
// サーバー設定
// ─────────────────────────────────────────────

const PORT = 8080;
const memoryStore = MemoryStore.create();
const DEFAULT_ACTOR_ID = 'default_user';

// ストリーミング応答の有効化フラグ
const STREAMING_ENABLED = process.env.RAIM_STREAMING !== 'false';

// ─────────────────────────────────────────────
// ヘビー処理判定（つなぎ言葉用）
// ─────────────────────────────────────────────

function needsHeavyProcessing(text, hasImage) {
  if (hasImage) return true;
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

const FILLER_PHRASES = [
  'んー、ちょっと待ってね……',
  'えっと、それね……',
  'あ、それ気になる。少し待って？',
];

const FILLER_PHRASES_IMAGE = [
  'えっ、何これ？……',
  'うわ、面白そう。',
  '画像？ふふ、見てみるね……',
];

function pickFiller(hasImage) {
  const pool = hasImage ? FILLER_PHRASES_IMAGE : FILLER_PHRASES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────
// WebSocket サーバー本体
// ─────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`\u2713 RAiM local server listening on ws://127.0.0.1:${PORT}`);
console.log(`  Streaming mode: ${STREAMING_ENABLED ? 'ON' : 'OFF'}`);
console.log(`  ${getTimeContext()}`);  // ← 起動時刻もログに表示

wss.on('connection', async (ws) => {
  console.log('[+] Client connected');

  const connectionContext = {
    actorId: DEFAULT_ACTOR_ID,
    sessionId: null,
  };

  // ─── 接続時の初期化 ───
  const { sessionId } = await memoryStore.startSession({
    actorId: connectionContext.actorId,
    sessionId: null,
  });
  connectionContext.sessionId = sessionId;

  ws.send(JSON.stringify(createSessionStart({ sessionId })));
  console.log(`[~] Session started: ${sessionId}`);

  // ─── メッセージ受信ハンドラ ───
  ws.on('message', async (rawData) => {

    // ① パース
    let parsed;
    try {
      parsed = JSON.parse(rawData.toString());
    } catch {
      ws.send(JSON.stringify(createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'JSON形式が不正です',
        retriable: false,
      })));
      return;
    }

    // ② バリデーション
    const validation = validateUpstream(parsed);
    if (!validation.valid) {
      ws.send(JSON.stringify(createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: validation.error,
        retriable: false,
      })));
      return;
    }

    // ③ パラメータ取得
    const sessionId = parsed.session_id || connectionContext.sessionId;
    const actorId = connectionContext.actorId;
    const userMessage = validation.message.text;
    const imageObjects = parsed.images || [];
    const imageBase64Array = imageObjects.map(img => img.data);
    const hasImage = imageBase64Array.length > 0;

    // リクエスト時刻もログに（時刻認識の動作確認用）
    console.log(`[<] User: ${userMessage} (session=${sessionId}${hasImage ? `, images=${imageBase64Array.length}` : ''}) [${getTimeContext()}]`);

    try {
      const t0 = Date.now();

      // ④ シーン判定 + 履歴取得（並列）
      const [picked, pastEvents] = await Promise.all([
        pickScene(userMessage, { images: imageBase64Array }),
        memoryStore.listEvents({ actorId, sessionId }),
      ]);
      const t1 = Date.now();

      const history = eventsToMessages(pastEvents);
      console.log(
        `[?] Scene: ${picked.scene.id} ` +
        `(score=${picked.score.toFixed(3)}, ${t1 - t0}ms, ` +
        `history=${history.length} turns, hasImage=${hasImage})`
      );

      // ⑤ プロンプト組立
      // buildMessages 内で現在時刻が自動的にシステムプロンプトに埋め込まれる
      const messages = buildMessages(
        picked.scene,
        userMessage,
        history,
        imageBase64Array
      );

      // ⑥ ストリーミング ON/OFF で分岐
      if (STREAMING_ENABLED) {
        await handleStreaming(ws, picked, messages, userMessage, hasImage, {
          actorId, sessionId, t0, t1,
        });
      } else {
        await handleNonStreaming(ws, picked, messages, userMessage, hasImage, {
          actorId, sessionId, t0, t1,
        });
      }

    } catch (err) {
      console.error('[!] Error:', err.message);

      let code = ERROR_CODES.INTERNAL_ERROR;
      if (err.message.includes('LLM') || err.message.includes('Ollama')) {
        code = ERROR_CODES.LLM_ERROR;
      } else if (err.message.includes('embed')) {
        code = ERROR_CODES.EMBED_ERROR;
      }

      ws.send(JSON.stringify(createError({
        code,
        message: 'えっと……ごめん、ちょっと調子悪いみたい。',
        retriable: true,
      })));
    }
  });

  ws.on('close', () => {
    console.log(`[-] Client disconnected (session=${connectionContext.sessionId})`);
  });
});

// ─────────────────────────────────────────────
// ストリーミング応答（A-3 標準モード）
// ─────────────────────────────────────────────

async function handleStreaming(ws, picked, messages, userMessage, hasImage, ctx) {
  const { actorId, sessionId, t0, t1 } = ctx;

  const metadataMsg = createMetadata({
    emotion: picked.defaultEmotion,
    intensity: picked.defaultIntensity,
    sceneId: picked.scene.id,
  });
  ws.send(JSON.stringify(metadataMsg));
  console.log(`[>] Metadata sent: emotion=${picked.defaultEmotion}, intensity=${picked.defaultIntensity}`);

  if (needsHeavyProcessing(userMessage, hasImage)) {
    const fillerText = pickFiller(hasImage);
    ws.send(JSON.stringify(createFiller({
      text: fillerText,
      emotion: picked.defaultEmotion,
      intensity: 0.5,
    })));
    console.log(`[>>] Filler: ${fillerText}`);
  }

  const extractor = new StreamingTextExtractor();
  let isFirstChunk = true;
  let rawAccumulated = '';

  for await (const token of callLLMStream(messages)) {
    rawAccumulated += token;
    const chunks = extractor.feed(token);
    for (const chunk of chunks) {
      ws.send(JSON.stringify(createTextChunk({
        text: chunk,
        isFirst: isFirstChunk,
      })));
      isFirstChunk = false;
    }
  }

  const lastChunk = extractor.flush();
  if (lastChunk && lastChunk.length > 0) {
    ws.send(JSON.stringify(createTextChunk({
      text: lastChunk,
      isFirst: isFirstChunk,
    })));
  }

  const t2 = Date.now();

  let finalEmotion = picked.defaultEmotion;
  let finalIntensity = picked.defaultIntensity;
  let fullText = '';
  let imageDescription = null;

  try {
    const cleaned = rawAccumulated
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const finalJson = JSON.parse(cleaned);

    fullText = finalJson.text || '';
    if (finalJson.emotion) finalEmotion = finalJson.emotion;
    if (typeof finalJson.intensity === 'number') finalIntensity = finalJson.intensity;
    if (finalJson.image_description) imageDescription = finalJson.image_description;
  } catch (e) {
    console.warn('[!] Final JSON parse failed:', e.message);
  }

  ws.send(JSON.stringify(createChatEnd({
    fullText,
    emotion: finalEmotion,
    intensity: finalIntensity,
  })));
  console.log(
    `[>] chat_end: emotion=${finalEmotion}, intensity=${finalIntensity}, ` +
    `text_len=${fullText.length}, LLM=${t2 - t1}ms, total=${t2 - t0}ms`
  );

  const userContent = buildUserContentWithImage(userMessage, imageDescription);
  await memoryStore.createEvent({
    actorId,
    sessionId,
    payload: [
      { role: Role.USER, content: { text: userContent } },
      { role: Role.ASSISTANT, content: { text: fullText } },
    ],
  });

  if (imageDescription) {
    console.log(`[+] Image described: "${imageDescription.slice(0, 60)}..."`);
  }
}

// ─────────────────────────────────────────────
// 非ストリーミング応答（旧クライアント互換モード）
// ─────────────────────────────────────────────

async function handleNonStreaming(ws, picked, messages, userMessage, hasImage, ctx) {
  const { actorId, sessionId, t0, t1 } = ctx;

  if (needsHeavyProcessing(userMessage, hasImage)) {
    const fillerText = pickFiller(hasImage);
    ws.send(JSON.stringify(createFiller({
      text: fillerText,
      emotion: picked.defaultEmotion,
      intensity: 0.5,
    })));
    console.log(`[>>] Filler: ${fillerText}`);
  }

  const rawLLMOutput = await callLLM(messages);
  const t2 = Date.now();

  const normalized = normalizeLLMOutput(rawLLMOutput);

  console.log(
    `[>] RAiM: ${normalized.text || normalized.message} ` +
    `(LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`
  );

  if (normalized.type === 'chat') {
    const imageDescription = normalized._imageDescription || null;
    const userContent = buildUserContentWithImage(userMessage, imageDescription);

    await memoryStore.createEvent({
      actorId,
      sessionId,
      payload: [
        { role: Role.USER, content: { text: userContent } },
        { role: Role.ASSISTANT, content: { text: normalized.text } },
      ],
    });

    if (imageDescription) {
      console.log(`[+] Image described: "${imageDescription.slice(0, 60)}..."`);
    }
  }

  const outputMsg = { ...normalized };
  delete outputMsg._imageDescription;
  ws.send(JSON.stringify(outputMsg));
}