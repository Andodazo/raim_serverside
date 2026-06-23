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

// 【v9 での変更点】
// - VOICEVOX 呼出をサーバー側で実施（旧: Flutter が直接叩いていた）
// - text_chunk と並行して audio_chunk（Base64 WAV）を送信
// - chunk_id で text と audio を紐付け
// - サーバー起動時に VOICEVOX 接続確認
//
// 【処理フロー】
//   metadata 即送信
//      ↓
//   LLM ストリーミング推論開始
//      ↓ トークン到着
//   StreamingTextExtractor で text を句単位抽出
//      ↓ 句完成
//   ├─ text_chunk JSON 送信（UI 表示用）
//   └─ VOICEVOX 非同期合成 → audio_chunk JSON 送信（再生用）
//      ↓ LLM 完了
//   chat_end 送信、履歴記録
//
// 【設計上のポイント】
// VOICEVOX 合成は非同期で並列実行する。
// 順序保証: chunk_id でクライアント側がペアリング
// テキストは即送り、音声は合成完了次第追っかけで送る形

// ==============================================================================
// RAiM 中継サーバー：C-1 Function Calling 統合版
// ==============================================================================
//
// 【v10 での変更点】
// - LLM 1回目を tools 付き呼出に変更（callLLMWithTools）
// - tool_calls 検出時：
//   1. 固定セリフ（pickToolIntro）を text_chunk + audio_chunk で送信
//   2. tool_call メッセージ送信（Flutter UI表示用）
//   3. ツール実行
//   4. tool 結果を messages に追加して次のターンへ
// - 最大3ターンまで連続実行、4ターン目は強制的にツールなし
// - ツールが返らない（通常応答）場合は既存のストリーミングフロー
//
// 【既存機能は全て維持】
// - ストリーミング応答（A-3）
// - マルチモーダル（画像入力）
// - 時刻認識（B-1）
// - 声プロファイル（B-2、サーバー内部）
// - TTS サーバー集約（D-2）
//
// 【v11 での修正点】
// - MAX_TOOL_TURNS を 3 → 2 に削減
// - 同じツール+引数の連続呼出を検知して強制終了
// - 最終応答強制プロンプトを強化（「ツール結果を活用して答える」を明示）
// - ツール失敗を検知してプロンプト分岐

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { callLLM, callLLMStream, callLLMWithTools } = require('./lib/llm');
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
  loadVoiceConfig,
  getVoiceParams,
  getActiveProfileInfo,
} = require('./lib/voice-mapper');
const {
  synthesize,
  wavToBase64,
  checkVoicevoxAvailable,
} = require('./lib/tts');
const {
  TOOL_DEFINITIONS,
  executeTool,
  pickToolIntro,
  getToolDescription,
} = require('./lib/tools');
const {
  EMOTIONS,
  ERROR_CODES,
  createFiller,
  createError,
  createSessionStart,
  createMetadata,
  createTextChunk,
  createAudioChunk,
  createChatEnd,
  createToolCall,
  normalizeLLMOutput,
  validateUpstream,
} = require('./lib/types');

const PORT = 8080;
const memoryStore = MemoryStore.create();
const DEFAULT_ACTOR_ID = 'default_user';
const STREAMING_ENABLED = process.env.RAIM_STREAMING !== 'false';

// 最大ツール呼出回数（2回で十分、応答時間と情報量のバランス）
const MAX_TOOL_TURNS = 2;

loadVoiceConfig();

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

function makeChunkIdGenerator(sessionId) {
  let counter = 0;
  return () => `${sessionId}_chunk_${counter++}`;
}

// 同じツール+引数の連続呼出を検知するキー生成
function makeToolCallKey(toolName, args) {
  return `${toolName}:${JSON.stringify(args)}`;
}

async function main() {
  const voicevoxOk = await checkVoicevoxAvailable();

  const wss = new WebSocketServer({ port: PORT });
  console.log(`\u2713 RAiM local server listening on ws://127.0.0.1:${PORT}`);
  console.log(`  Streaming mode: ${STREAMING_ENABLED ? 'ON' : 'OFF'}`);
  console.log(`  TTS mode: ${voicevoxOk ? 'ON (server-side VOICEVOX)' : 'OFF (text only)'}`);
  console.log(`  ${getTimeContext()}`);
  const profileInfo = getActiveProfileInfo();
  if (profileInfo) {
    console.log(`  Voice profile: ${profileInfo.name} (${profileInfo.speaker_name})`);
  }
  console.log(`  Tools: ${TOOL_DEFINITIONS.map(t => t.function.name).join(', ')}`);
  console.log(`  Max tool turns: ${MAX_TOOL_TURNS}`);

  if (!process.env.TAVILY_API_KEY) {
    console.warn('  ⚠ TAVILY_API_KEY not set, web_search will fail');
  }
  if (!process.env.OPENWEATHERMAP_API_KEY) {
    console.warn('  ⚠ OPENWEATHERMAP_API_KEY not set, get_weather will fail');
  }

  wss.on('connection', async (ws) => {
    console.log('[+] Client connected');

    const connectionContext = {
      actorId: DEFAULT_ACTOR_ID,
      sessionId: null,
      ttsEnabled: voicevoxOk,
    };

    const { sessionId } = await memoryStore.startSession({
      actorId: connectionContext.actorId,
      sessionId: null,
    });
    connectionContext.sessionId = sessionId;

    ws.send(JSON.stringify(createSessionStart({ sessionId })));
    console.log(`[~] Session started: ${sessionId}`);

    ws.on('message', async (rawData) => {
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

      const validation = validateUpstream(parsed);
      if (!validation.valid) {
        ws.send(JSON.stringify(createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: validation.error,
          retriable: false,
        })));
        return;
      }

      const sessionId = parsed.session_id || connectionContext.sessionId;
      const actorId = connectionContext.actorId;
      const userMessage = validation.message.text;
      const imageObjects = parsed.images || [];
      const imageBase64Array = imageObjects.map(img => img.data);
      const hasImage = imageBase64Array.length > 0;

      console.log(`[<] User: ${userMessage} (session=${sessionId}${hasImage ? `, images=${imageBase64Array.length}` : ''}) [${getTimeContext()}]`);

      try {
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

        await handleRequest(ws, picked, userMessage, hasImage, imageBase64Array, history, {
          actorId, sessionId, t0, t1,
          ttsEnabled: connectionContext.ttsEnabled,
        });
      } catch (err) {
        console.error('[!] Error:', err.message);
        console.error(err.stack);

        let code = ERROR_CODES.INTERNAL_ERROR;
        if (err.message.includes('LLM') || err.message.includes('Ollama')) {
          code = ERROR_CODES.LLM_ERROR;
        } else if (err.message.includes('embed')) {
          code = ERROR_CODES.EMBED_ERROR;
        } else if (err.message.includes('VOICEVOX') || err.message.includes('TTS')) {
          code = ERROR_CODES.TTS_ERROR;
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
}

async function handleRequest(ws, picked, userMessage, hasImage, imageBase64Array, history, ctx) {
  const { actorId, sessionId, t0, t1, ttsEnabled } = ctx;
  const nextChunkId = makeChunkIdGenerator(sessionId);

  ws.send(JSON.stringify(createMetadata({
    emotion: picked.defaultEmotion,
    intensity: picked.defaultIntensity,
    sceneId: picked.scene.id,
  })));
  console.log(`[>] Metadata sent: emotion=${picked.defaultEmotion}, intensity=${picked.defaultIntensity}`);

  let messages = buildMessages(
    picked.scene,
    userMessage,
    history,
    imageBase64Array,
    { withTools: true }
  );

  let toolTurn = 0;
  let imageDescription = null;
  let finalText = '';
  let finalEmotion = picked.defaultEmotion;
  let finalIntensity = picked.defaultIntensity;
  let toolError = false;
  let exitedDueToDuplicate = false;
  const seenToolCalls = new Set();

  while (toolTurn < MAX_TOOL_TURNS) {
    toolTurn++;
    console.log(`[Tool Loop] Turn ${toolTurn}/${MAX_TOOL_TURNS}`);

    const llmResult = await callLLMWithTools(messages, TOOL_DEFINITIONS);

    if (llmResult.thinking) {
      console.log(`  [Thinking] ${llmResult.thinking.slice(0, 200).replace(/\n/g, ' ')}...`);
    }

    if (llmResult.tool_calls && llmResult.tool_calls.length > 0) {
      console.log(`  [Tool Calls] ${llmResult.tool_calls.length} tool(s) requested`);

      // 重複検知
      let hasDuplicate = false;
      for (const toolCall of llmResult.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = toolCall.function.arguments;
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            toolArgs = {};
          }
        }
        const key = makeToolCallKey(toolName, toolArgs);
        if (seenToolCalls.has(key)) {
          console.warn(`  [!] Duplicate tool call detected: ${key}, forcing final response`);
          hasDuplicate = true;
          exitedDueToDuplicate = true;
          break;
        }
      }
      if (hasDuplicate) break;

      for (const toolCall of llmResult.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = toolCall.function.arguments;
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch (e) {
            console.warn(`  [Tool] Failed to parse arguments: ${toolArgs}`);
            toolArgs = {};
          }
        }

        seenToolCalls.add(makeToolCallKey(toolName, toolArgs));

        const introText = pickToolIntro(toolName, toolTurn);
        const introChunkId = nextChunkId();
        ws.send(JSON.stringify(createTextChunk({
          text: introText,
          chunkId: introChunkId,
          isFirst: toolTurn === 1,
        })));
        console.log(`  [Intro] ${introText}`);

        if (ttsEnabled) {
          const voiceParams = getVoiceParams(picked.defaultEmotion, 0.6);
          synthesizeAndSend(ws, introChunkId, introText, voiceParams)
            .catch(err => console.warn(`  [TTS] Intro error: ${err.message}`));
        }

        ws.send(JSON.stringify(createToolCall({
          tool: toolName,
          description: getToolDescription(toolName, toolArgs),
          estimatedSeconds: 3,
        })));
        console.log(`  [>] tool_call: ${toolName}`);

        const toolResult = await executeTool(toolName, toolArgs);

        if (toolResult && toolResult.error) {
          toolError = true;
          console.warn(`  [!] Tool returned error: ${toolResult.message}`);
        }

        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        });
        messages.push({
          role: 'tool',
          name: toolName,
          content: JSON.stringify(toolResult),
        });
      }

      continue;
    }

    // ツールなし通常応答
    console.log(`  [No tool] LLM returned normal response`);

    const content = llmResult.content || '';
    try {
      const cleaned = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned);

      finalText = parsed.text || '';
      if (parsed.emotion) finalEmotion = parsed.emotion;
      if (typeof parsed.intensity === 'number') finalIntensity = parsed.intensity;
      if (parsed.image_description) imageDescription = parsed.image_description;
    } catch (e) {
      console.warn(`  [!] Failed to parse LLM JSON: ${e.message}, content="${content.slice(0, 200)}"`);
      finalText = content;
    }
    break;
  }

  // 強制応答
  if (finalText === '') {
    const reason = exitedDueToDuplicate
      ? '同じツールの重複呼出を防ぐため'
      : `最大ターン数(${MAX_TOOL_TURNS})に到達したため`;
    console.log(`  [!] Forcing final response (${reason})`);

    const forcePrompt = toolError
      ? '上記でいくつかツールを実行しました。一部失敗もありますが、得られた情報を踏まえて、ユーザーへの最終応答を生成してください。ツールはこれ以上使わず、tool ロールで返ってきた情報を活用して答えてください。応答はライムキャラのまま、必ず以下のJSON形式で: {"type":"chat","text":"...","emotion":"happy/sad/angry/surprised/neutral/caring","intensity":0.0-1.0}'
      : '上記のツール実行結果（tool ロールの content）を踏まえて、ユーザーへの最終応答を生成してください。ツールはこれ以上使わず、ツール結果の情報を活用して、ユーザーの質問に具体的に答えてください。応答はライムキャラのまま、必ず以下のJSON形式で: {"type":"chat","text":"...","emotion":"happy/sad/angry/surprised/neutral/caring","intensity":0.0-1.0}';

    messages.push({
      role: 'user',
      content: forcePrompt,
    });

    const finalLlmResult = await callLLM(messages);
    try {
      const cleaned = finalLlmResult
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      finalText = parsed.text || finalLlmResult;
      if (parsed.emotion) finalEmotion = parsed.emotion;
      if (typeof parsed.intensity === 'number') finalIntensity = parsed.intensity;
    } catch (e) {
      console.warn(`  [!] Final force-response parse failed: ${e.message}`);
      finalText = finalLlmResult;
    }
  }

  await sendFinalResponseAsChunks(
    ws, finalText, finalEmotion, finalIntensity,
    nextChunkId, ttsEnabled, toolTurn === 0
  );

  ws.send(JSON.stringify(createChatEnd({
    fullText: finalText,
    emotion: finalEmotion,
    intensity: finalIntensity,
  })));

  const t2 = Date.now();
  console.log(
    `[>] chat_end: emotion=${finalEmotion}, intensity=${finalIntensity}, ` +
    `text_len=${finalText.length}, toolTurns=${seenToolCalls.size}, ` +
    `total=${t2 - t0}ms`
  );

  const userContent = buildUserContentWithImage(userMessage, imageDescription);
  await memoryStore.createEvent({
    actorId,
    sessionId,
    payload: [
      { role: Role.USER, content: { text: userContent } },
      { role: Role.ASSISTANT, content: { text: finalText } },
    ],
  });

  if (imageDescription) {
    console.log(`[+] Image described: "${imageDescription.slice(0, 60)}..."`);
  }
}

async function sendFinalResponseAsChunks(ws, fullText, emotion, intensity, nextChunkId, ttsEnabled, isFirst) {
  if (!fullText || fullText.length === 0) return;

  const chunks = splitIntoChunks(fullText);
  const ttsPromises = [];
  const voiceParams = ttsEnabled ? getVoiceParams(emotion, intensity) : null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkId = nextChunkId();
    const isFirstChunk = isFirst && i === 0;

    ws.send(JSON.stringify(createTextChunk({
      text: chunk,
      chunkId,
      isFirst: isFirstChunk,
    })));

    if (ttsEnabled && voiceParams) {
      const promise = synthesizeAndSend(ws, chunkId, chunk, voiceParams)
        .catch(err => console.warn(`[!] TTS error for ${chunkId}: ${err.message}`));
      ttsPromises.push(promise);
    }
  }

  if (ttsPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(ttsPromises),
      new Promise(resolve => setTimeout(resolve, 15000)),
    ]);
  }
}

function splitIntoChunks(text) {
  const chunks = [];
  let current = '';
  const BREAK_CHARS = /[。、！？\n]/;
  const MAX_LENGTH = 30;

  for (const ch of text) {
    current += ch;
    if (BREAK_CHARS.test(ch) || current.length >= MAX_LENGTH) {
      chunks.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function synthesizeAndSend(ws, chunkId, text, voiceParams) {
  const t0 = Date.now();
  const wavBuffer = await synthesize(text, voiceParams);
  const t1 = Date.now();
  const audioBase64 = wavToBase64(wavBuffer);
  const t2 = Date.now();

  ws.send(JSON.stringify(createAudioChunk({
    chunkId,
    audioBase64,
    format: 'wav',
  })));

  console.log(
    `[♪] audio_chunk sent: id=${chunkId}, ` +
    `text_len=${text.length}, wav_size=${Math.floor(wavBuffer.length / 1024)}KB, ` +
    `synth=${t1 - t0}ms, encode=${t2 - t1}ms`
  );
}

main().catch(err => {
  console.error('[FATAL] Server startup failed:', err);
  process.exit(1);
});