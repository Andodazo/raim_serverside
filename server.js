// server.js (フェーズ4：つなぎ言葉 UX)
require('dotenv').config();
const { WebSocketServer } = require('ws');
const { callLLM } = require('./lib/llm');
const { buildMessages } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');

const PORT = 8080;

// 「これは時間がかかる処理」と判定するキーワード
function needsHeavyProcessing(text) {
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

// つなぎセリフのバリエーション
const FILLER_PHRASES = [
  'んー、ちょっと待ってね。今調べるから……',
  'えっと、それね……ちょっと考えるね。',
  'あ、それ気になる。少し待って？',
  'うーん、それは……ちょっと整理させて。'
];

function pickFiller() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

const wss = new WebSocketServer({ port: PORT });
console.log(`✓ RAiM local server listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[+] Client connected');

  ws.on('message', async (data) => {
    let userMessage;
    try {
      userMessage = JSON.parse(data).text;
    } catch {
      userMessage = data.toString();
    }
    console.log(`[<] User: ${userMessage}`);

    try {
      // ① ヘビー処理が必要そうなら、即座につなぎセリフを送る
      const isHeavy = needsHeavyProcessing(userMessage);
      if (isHeavy) {
        const fillerText = pickFiller();
        ws.send(JSON.stringify({
          type: 'filler_audio',  // ← Flutter側で「音声だけ再生」と判別
          text: fillerText,
          emotion: 'neutral',
          intensity: 0.5
        }));
        console.log(`[>>] Filler: ${fillerText}`);
      }

      // ② 通常処理
      const t0 = Date.now();
      const picked = await pickScene(userMessage);
      const t1 = Date.now();
      console.log(`[?] Scene: ${picked.scene.id} (score=${picked.score.toFixed(3)}, ${t1 - t0}ms)`);

      const messages = buildMessages(picked.scene, userMessage);
      const aiText = await callLLM(messages);
      const t2 = Date.now();
      console.log(`[>] RAiM: ${aiText} (LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`);

      // ③ 本回答を送る
      ws.send(aiText);
    } catch (err) {
      console.error('[!] Error:', err.message);
      ws.send(JSON.stringify({
        type: 'chat',
        text: 'えっと……ごめん、ちょっと調子悪いみたい。',
        emotion: 'sad',
        intensity: 0.5
      }));
    }
  });

  ws.on('close', () => console.log('[-] Client disconnected'));
});