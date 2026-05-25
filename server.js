// server.js (フェーズ4+α：types.js を使う形にリファクタ)
//
// 既存の server.js との差分:
// - require('./lib/types') で型ユーティリティを取り込み
// - 直書きしていた JSON を createChat() / createFiller() / createError() に置換
// - LLM 応答の正規化を normalizeLLMOutput() に集約
// - emotion / intensity / version の整合性が自動保証される
//
// 配置先: RAiM_serverside/server.js（既存ファイルを置き換え）

require('dotenv').config();
const { WebSocketServer } = require('ws');
const { callLLM } = require('./lib/llm');
const { buildMessages } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');
const {
  EMOTIONS,
  ERROR_CODES,
  createChat,
  createFiller,
  createError,
  normalizeLLMOutput,
  validateUpstream,
} = require('./lib/types');

const PORT = 8080;

// ─────────────────────────────────────────────
// ヘビー処理判定（つなぎ言葉を出すかどうか）
// ─────────────────────────────────────────────
function needsHeavyProcessing(text) {
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

const FILLER_PHRASES = [
  'んー、ちょっと待ってね。今調べるから……',
  'えっと、それね……ちょっと考えるね。',
  'あ、それ気になる。少し待って？',
  'うーん、それは……ちょっと整理させて。',
];

function pickFiller() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

// ─────────────────────────────────────────────
// WebSocket サーバー
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
console.log(`✓ RAiM local server listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[+] Client connected');

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

    const userMessage = validation.message.text;
    console.log(`[<] User: ${userMessage}`);

    try {
      // ① ヘビー処理が必要そうなら、即座につなぎセリフを送る
      if (needsHeavyProcessing(userMessage)) {
        const fillerText = pickFiller();
        const fillerMsg = createFiller({
          text: fillerText,
          emotion: EMOTIONS.NEUTRAL,
          intensity: 0.5,
        });
        ws.send(JSON.stringify(fillerMsg));
        console.log(`[>>] Filler: ${fillerText}`);
      }

      // ② シーン判定 + LLM 推論
      const t0 = Date.now();
      const picked = await pickScene(userMessage);
      const t1 = Date.now();
      console.log(`[?] Scene: ${picked.scene.id} (score=${picked.score.toFixed(3)}, ${t1 - t0}ms)`);

      const messages = buildMessages(picked.scene, userMessage);
      const rawLLMOutput = await callLLM(messages);
      const t2 = Date.now();

      // ③ LLM 応答を正規化（コードフェンス除去 + chat メッセージ化）
      const normalized = normalizeLLMOutput(rawLLMOutput);

      console.log(`[>] RAiM: ${normalized.text || normalized.message} (LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`);
      ws.send(JSON.stringify(normalized));
    } catch (err) {
      console.error('[!] Error:', err.message);

      // エラー種別を判定
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

  ws.on('close', () => console.log('[-] Client disconnected'));
});