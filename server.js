// server.js
// ==============================================================================
// RAiM 中継サーバー：Flutter ↔ Ollama/Bedrock のブリッジ
// ==============================================================================
//
// 【このファイルの役割】
// Flutter からの WebSocket 接続を受け、シーン判定 → 履歴取得 → プロンプト組立
// → LLM 推論 → 応答返却 までの一連の流れを統括する。
//
// 【処理の流れ】
//   [Flutter] ─ ws.send({text}) ──→ [server.js]
//                                       │
//                                       ├ Embedding でシーン判定 (pick-scene.js)
//                                       ├ 履歴取得 (memory-store.js)  ※並列実行
//                                       │
//                                       ├ プロンプト組立 (prompt-builder.js)
//                                       │
//                                       ├ LLM 推論 (llm.js)
//                                       │
//                                       ├ 履歴に記録 (memory-store.js)
//                                       │
//                                       └ 応答送信 ─→ [Flutter]
//
// 【接続管理】
// 1接続=1セッション。接続時に session_start を Flutter に送る。
// 切断したら別セッション扱い（再接続時は新セッション）

require('dotenv').config();
const { WebSocketServer } = require('ws');
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
  createSessionStart,
  normalizeLLMOutput,
  validateUpstream,
} = require('./lib/types');

// ─────────────────────────────────────────────
// サーバー設定
// ─────────────────────────────────────────────

const PORT = 8080;

// MemoryStore のインスタンス
// RAIM_MODE 環境変数によりローカル/本番 が切り替わる
const memoryStore = MemoryStore.create();

// 仮の actorId（ユーザー識別子）
// 今は全ユーザー共通の固定値だが、将来の認証実装で個人ごとに差し替える
const DEFAULT_ACTOR_ID = 'default_user';

// ─────────────────────────────────────────────
// ヘビー処理判定
// ─────────────────────────────────────────────
//
// 検索や時間のかかる処理が必要そうな質問を、キーワードで判定する。
// 真なら filler_audio を即座に Flutter に送って「考え中感」を演出。
// 偽なら通常通り chat を1回返すだけ。

function needsHeavyProcessing(text) {
  return /(天気|ニュース|調べて|教えて|検索|何時|今いつ)/.test(text);
}

// つなぎ言葉のバリエーション（毎回同じだと不自然なのでランダム）
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
// WebSocket サーバー本体
// ─────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`\u2713 RAiM local server listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', async (ws) => {
  console.log('[+] Client connected');

  // この接続専用のコンテキスト
  // 1接続 = 1セッション
  const connectionContext = {
    actorId: DEFAULT_ACTOR_ID,
    sessionId: null,  // この後 startSession で発行
  };

  // ─── 接続時の初期化 ───
  // セッション開始 → sessionID 発行 → Flutter に通知
  const { sessionId } = await memoryStore.startSession({
    actorId: connectionContext.actorId,
    sessionId: null,  // null を渡すと新規発行
  });
  connectionContext.sessionId = sessionId;

  // session_start メッセージで Flutter に sessionID を伝える
  // Flutter はこの ID を内部保持し、以降の send に含める
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

    // ③ sessionID の決定
    // - Flutter から指定があればそれを使う（手動セッション切替の備え）
    // - なければ接続時に発行したものを使う
    const sessionId = parsed.session_id || connectionContext.sessionId;
    const actorId = connectionContext.actorId;
    const userMessage = validation.message.text;

    console.log(`[<] User: ${userMessage} (session=${sessionId})`);

    try {
      // ④ ヘビー処理判定 → 必要ならつなぎ言葉を即送信
      // これは LLM 推論を待たずに送れるので、体感レイテンシが激減する
      if (needsHeavyProcessing(userMessage)) {
        const fillerText = pickFiller();
        ws.send(JSON.stringify(createFiller({
          text: fillerText,
          emotion: EMOTIONS.NEUTRAL,
          intensity: 0.5,
        })));
        console.log(`[>>] Filler: ${fillerText}`);
      }

      // ⑤ シーン判定 と 履歴取得 を並列実行
      // 両方とも独立した処理（依存関係なし）なので並列で時間短縮
      // Promise.all を使うことで、シーン判定が遅くても履歴取得は並行に進む
      const t0 = Date.now();
      const [picked, pastEvents] = await Promise.all([
        pickScene(userMessage),
        memoryStore.listEvents({ actorId, sessionId }),
      ]);
      const t1 = Date.now();

      // 履歴を LLM 用の messages 形式に変換
      const history = eventsToMessages(pastEvents);
      console.log(`[?] Scene: ${picked.scene.id} (score=${picked.score.toFixed(3)}, ${t1 - t0}ms, history=${history.length} turns)`);

      // ⑥ プロンプト組立 → LLM 推論
      const messages = buildMessages(picked.scene, userMessage, history);
      const rawLLMOutput = await callLLM(messages);
      const t2 = Date.now();

      // ⑦ LLM 応答を正規化（コードフェンス除去・パース・整形）
      const normalized = normalizeLLMOutput(rawLLMOutput);

      console.log(`[>] RAiM: ${normalized.text || normalized.message} (LLM: ${t2 - t1}ms, total: ${t2 - t0}ms)`);

      // ⑧ 履歴に記録
      // chat 型の応答のみ記録（error 型を残すとライムが「調子悪い」前提で次回返答してしまう）
      // ユーザー発言と応答を1イベントとしてまとめて記録
      if (normalized.type === 'chat') {
        await memoryStore.createEvent({
          actorId,
          sessionId,
          payload: [
            { role: Role.USER, content: { text: userMessage } },
            { role: Role.ASSISTANT, content: { text: normalized.text } },
          ],
        });
      }

      // ⑨ 応答を Flutter に送信
      ws.send(JSON.stringify(normalized));

    } catch (err) {
      console.error('[!] Error:', err.message);

      // エラー種別を推測してコード分類
      // Flutter 側がコードで自動リトライ判断などをするための情報
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

  // ─── 切断時 ───
  // セッションを即座に消すわけではない（TTL 30分で自動削除される）
  // 再接続時に同じ session_id を Flutter が指定すれば履歴を引き継げる
  // （ただし現状の Flutter 側実装では切断時に session_id を破棄するので、
  //  再接続時は新セッションとなる。将来の「会話継続」機能で活用予定）
  ws.on('close', () => {
    console.log(`[-] Client disconnected (session=${connectionContext.sessionId})`);
  });
});