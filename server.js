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

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { callLLM } = require('./lib/llm');
const { buildMessages } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');
const {
  MemoryStore,
  Role,
  eventsToMessages,
  buildUserContentWithImage,
} = require('./lib/memory-store');
const {
  EMOTIONS,
  ERROR_CODES,
  createFiller,
  createError,
  createSessionStart,
  normalizeLLMOutput,
  validateUpstream,
} = require('./lib/types');

// ─────────────────────────────────────────────
// サーバー設定
// ─────────────────────────────────────────────

const PORT = 8080;
const memoryStore = MemoryStore.create();

// 仮の actorId（将来の認証で個人ごとに差し替え）
const DEFAULT_ACTOR_ID = 'default_user';

// ─────────────────────────────────────────────
// ヘビー処理判定（つなぎ言葉を出すかどうか）
// ─────────────────────────────────────────────

function needsHeavyProcessing(text, hasImage) {
  // 画像がある時は推論が長くなりがちなのでつなぎ言葉を出す
  if (hasImage) return true;
  // テキストでも検索系キーワードがあればつなぎ言葉
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

const FILLER_PHRASES = [
  'んー、ちょっと待ってね。今見てるから……',
  'えっと、それね……ちょっと考えるね。',
  'あ、それ気になる。少し待って？',
  'うーん、それは……ちょっと整理させて。',
];

// 画像専用のつなぎ言葉（「見る」表現）
const FILLER_PHRASES_IMAGE = [
  'えっ、何これ？……ちょっと見せて？',
  'うわ、面白そう。ちょっと見るね？',
  '画像？ふふ、何が写ってるんだろう……',
  'お、写真くれた？ちょっと待ってね……',
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

wss.on('connection', async (ws) => {
  console.log('[+] Client connected');

  // 接続単位でセッション情報を保持
  const connectionContext = {
    actorId: DEFAULT_ACTOR_ID,
    sessionId: null,
  };

  // ─── 接続時の初期化：セッション開始 + 通知 ───
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
    // types.js の validateUpstream で images 配列のバリデーションも含めて実施
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
    const imageObjects = parsed.images || []; // [{data, media_type}, ...]
    const imageBase64Array = imageObjects.map(img => img.data); // ['base64...', ...]
    const hasImage = imageBase64Array.length > 0;

    console.log(`[<] User: ${userMessage} (session=${sessionId}${hasImage ? `, images=${imageBase64Array.length}` : ''})`);

    try {
      // ④ ヘビー処理ならつなぎ言葉を即送信
      if (needsHeavyProcessing(userMessage, hasImage)) {
        const fillerText = pickFiller(hasImage);
        ws.send(JSON.stringify(createFiller({
          text: fillerText,
          emotion: EMOTIONS.NEUTRAL,
          intensity: 0.5,
        })));
        console.log(`[>>] Filler: ${fillerText}`);
      }

      // ⑤ シーン判定 と 履歴取得 を並列実行
      const t0 = Date.now();
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

      // ⑥ プロンプト組立（画像も含めて Ollama messages 形式に）
      const messages = buildMessages(
        picked.scene,
        userMessage,
        history,
        imageBase64Array  // 画像 Base64 配列を渡す
      );

      // ⑦ LLM 推論
      const rawLLMOutput = await callLLM(messages);
      const t2 = Date.now();

      // ⑧ LLM 応答を正規化
      // image_description は normalized._imageDescription として内部保持
      // Flutter には送られない
      const normalized = normalizeLLMOutput(rawLLMOutput);

      console.log(
        `[>] RAiM: ${normalized.text || normalized.message} ` +
        `(LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`
      );

      // ⑨ 履歴に記録
      // chat 型のみ記録（error は記録しない）
      // ユーザー発言は画像説明と結合してテキスト化
      if (normalized.type === 'chat') {
        // 画像説明があれば、それをユーザー発言に埋め込む
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

      // ⑩ Flutter に送信（_imageDescription は除去して送る）
      // _ で始まるフィールドは types.js 側で除外される設計だが、ここでも明示的に消す
      const outputMsg = { ...normalized };
      delete outputMsg._imageDescription;
      ws.send(JSON.stringify(outputMsg));

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