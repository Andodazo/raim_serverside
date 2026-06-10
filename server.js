// server.js (フェーズA-1: 会話履歴のサーバー側保存対応)
//
// 変更点:
// - MemoryStore を導入し、actorId/sessionId 単位で履歴を保持
// - WebSocket 接続時に sessionID を発行し、session_start メッセージで Flutter に通知
// - Flutter から送られる session_id を受信し、対応する履歴を listEvents で取得
// - 履歴を prompt-builder に渡してプロンプトに含める
// - 応答完了後、createEvent で履歴を記録

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { callLLM } = require('./lib/llm');
const { buildMessages } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');
const { MemoryStore, Role, eventsToMessages } = require('./lib/memory-store');
const {
  EMOTIONS,
  ERROR_CODES,
  createChat,
  createFiller,
  createError,
  normalizeLLMOutput,
  validateUpstream,
  SCHEMA_VERSION,
} = require('./lib/types');

const PORT = 8080;
const memoryStore = MemoryStore.create();

// ─────────────────────────────────────────────
// 仮の actorId（将来の認証で差し替える）
// 今は全ユーザー共通の "default_user"
// ─────────────────────────────────────────────
const DEFAULT_ACTOR_ID = 'default_user';

// ─────────────────────────────────────────────
// ヘビー処理判定（つなぎ言葉を出すかどうか）
// ─────────────────────────────────────────────
function needsHeavyProcessing(text) {
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

const FILLER_PHRASES = [
  'んー、ちょっと待ってね。今調べるから……',
  'えっと、それね……ちょっと考えるね。',
  'あ、それ気になる。少し待って?',
  'うーん、それは……ちょっと整理させて。',
];

function pickFiller() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

// ─────────────────────────────────────────────
// WebSocket サーバー
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
console.log(`\u2713 RAiM local server listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', async (ws) => {
  console.log('[+] Client connected');

  // 接続単位でセッション情報を保持
  const connectionContext = {
    actorId: DEFAULT_ACTOR_ID,
    sessionId: null, // session_start で発行
  };

  // ① 接続時に sessionId を発行し、Flutter に通知
  const { sessionId } = await memoryStore.startSession({
    actorId: connectionContext.actorId,
    sessionId: null,
  });
  connectionContext.sessionId = sessionId;

  ws.send(JSON.stringify({
    version: SCHEMA_VERSION,
    type: 'session_start',
    session_id: sessionId,
  }));
  console.log(`[~] Session started: ${sessionId}`);

  ws.on('message', async (rawData) => {
    // 受信メッセージのパース + バリデーション
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

    // session_id が指定されていればそれを使い、なければ接続時のものを使う
    // （Flutter 側が手動でセッション切り替える時の備え）
    const sessionId = parsed.session_id || connectionContext.sessionId;
    const actorId = connectionContext.actorId;
    const userMessage = validation.message.text;

    console.log(`[<] User: ${userMessage} (session=${sessionId})`);

    try {
      // ② ヘビー処理が必要そうなら、即座につなぎセリフを送る
      if (needsHeavyProcessing(userMessage)) {
        const fillerText = pickFiller();
        ws.send(JSON.stringify(createFiller({
          text: fillerText,
          emotion: EMOTIONS.NEUTRAL,
          intensity: 0.5,
        })));
        console.log(`[>>] Filler: ${fillerText}`);
      }

      // ③ シーン判定と履歴取得を並列実行（フェーズA-2 の先取り）
      const t0 = Date.now();
      const [picked, pastEvents] = await Promise.all([
        pickScene(userMessage),
        memoryStore.listEvents({ actorId, sessionId }),
      ]);
      const t1 = Date.now();

      const history = eventsToMessages(pastEvents);
      console.log(`[?] Scene: ${picked.scene.id} (score=${picked.score.toFixed(3)}, ${t1 - t0}ms, history=${history.length} turns)`);

      // ④ プロンプト組立と LLM 推論
      const messages = buildMessages(picked.scene, userMessage, history);
      const rawLLMOutput = await callLLM(messages);
      const t2 = Date.now();

      // ⑤ LLM 応答を正規化
      const normalized = normalizeLLMOutput(rawLLMOutput);

      console.log(`[>] RAiM: ${normalized.text || normalized.message} (LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`);

      // ⑥ 履歴に記録（ユーザー発言と応答を1イベントとして）
      // chat 型の応答のみ記録（error 型は記録しない）
      if (normalized.type === 'chat') {
        await memoryStore.createEvent({
          actorId,
          sessionId,
          payload: [
            {
              role: Role.USER,
              content: { text: userMessage },
            },
            {
              role: Role.ASSISTANT,
              content: { text: normalized.text },
            },
          ],
        });
      }

      ws.send(JSON.stringify(normalized));
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