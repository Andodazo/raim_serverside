// lib/types.js
// ==============================================================================
// WebSocket メッセージの型定義 + ファクトリ関数
// ==============================================================================
//
// 【このファイルの役割】
// サーバー(Node.js) と Flutter の間で WebSocket 上を流れる JSON メッセージの
// 型・定数・組立関数を一元管理する。
//
// 【なぜファクトリ関数？】
// JSON を直接 ws.send で書き散らかすと:
// - version の付け忘れ
// - intensity が範囲外（1.5 とか -0.3 とか）
// - type 名のタイポ（"cat" とか "chats"）
// が頻発する。
//
// createChat({...}) のような関数経由にすれば、これらが自動的に防げる。
//
// 【スキーマ仕様の正本】
// docs/json-schema.md。仕様変更の際はこのファイルと両方更新すること。

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン
// ─────────────────────────────────────────────
//
// 破壊的変更（既存フィールドの型変更・削除）をする時に上げる。
// 単にフィールドを追加するだけなら version は変えない。
// Flutter 側で version > 1 を受信したら警告ログを出す設計になっている。

const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// type 列挙
// ─────────────────────────────────────────────
//
// メッセージの種別。Flutter 側はこの type で処理を分岐する。
// 新しい type を追加する時は、ここに追加 + ファクトリ関数追加 + json-schema.md 更新。

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',                     // 通常のライム応答（UIに吹き出し追加）
  FILLER_AUDIO: 'filler_audio',     // つなぎ言葉（音声だけ、UIには出さない）
  TOOL_CALL: 'tool_call',           // ツール実行通知（検索中...等）将来実装
  PROACTIVE_MESSAGE: 'proactive_message', // ライムから能動発信。将来実装
  ERROR: 'error',                   // エラー通知
  SESSION_START: 'session_start',   // セッション開始通知（sessionID 配布）
});

// ─────────────────────────────────────────────
// emotion 列挙
// ─────────────────────────────────────────────
//
// Unity 側の立ち絵切替に使う。
// 基本5種は Unity 側の立ち絵スプライトと対応している。
// 拡張値（caring等）は Unity 側で対応する立ち絵がない場合、neutral にフォールバックする。

const EMOTIONS = Object.freeze({
  // Unity 立ち絵 5 種に対応
  NEUTRAL: 'neutral',     // 通常
  HAPPY: 'happy',         // 喜び
  SAD: 'sad',             // 悲しみ
  ANGRY: 'angry',         // 怒り
  SURPRISED: 'surprised', // 驚き
  // 拡張値（Unity 立ち絵未対応時は default にフォールバック）
  CARING: 'caring',       // 思いやり・優しさ
  EMBARRASSED: 'embarrassed', // 照れ・困惑
  EXCITED: 'excited',     // 興奮・テンション高
});

// ─────────────────────────────────────────────
// error コード列挙
// ─────────────────────────────────────────────
//
// エラーの種別。Flutter 側はこのコードを見て:
// - ユーザーに表示するメッセージを変える
// - 自動リトライするかを決める
// などの判断ができる。

const ERROR_CODES = Object.freeze({
  LLM_TIMEOUT: 'LLM_TIMEOUT',         // LLM応答タイムアウト
  LLM_ERROR: 'LLM_ERROR',             // LLM推論エラー（パース失敗含む）
  EMBED_ERROR: 'EMBED_ERROR',         // Embedding 計算エラー
  INVALID_INPUT: 'INVALID_INPUT',     // 送信内容が不正
  INTERNAL_ERROR: 'INTERNAL_ERROR',   // サーバー内部エラー（詳細不明）
  RATE_LIMIT: 'RATE_LIMIT',           // レート制限
  MAINTENANCE: 'MAINTENANCE',         // メンテナンス中
});

// ─────────────────────────────────────────────
// ツール名列挙
// ─────────────────────────────────────────────
//
// tool_call メッセージで使うツールの識別子。
// 将来 calendar, camera, smarthome 等が追加される想定。

const TOOLS = Object.freeze({
  WEB_SEARCH: 'web_search',
});

// ─────────────────────────────────────────────
// ファクトリ関数
// ─────────────────────────────────────────────

/**
 * intensity を 0.0〜1.0 にクランプする
 * - NaN や undefined が来たら 0.5 を返す
 * - 1.5 が来たら 1.0、-0.3 が来たら 0.0
 *
 * 不正値で LLM やクライアントを混乱させないための防御
 */
function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * chat メッセージ（通常応答）を作成
 * Flutter は受信したらチャットUIに吹き出し追加 + TTS再生 + Unity 表情変化
 */
function createChat({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

/**
 * filler_audio メッセージ（つなぎ言葉）を作成
 *
 * Flutter は受信したら:
 * - チャットUIには追加しない（重要、chatと違うところ）
 * - 音声だけ再生して「考えてる感」を演出
 *
 * 検索や重い処理の前に即座に送ることで体感レイテンシを下げる
 */
function createFiller({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.FILLER_AUDIO,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

/**
 * tool_call メッセージ（ツール実行通知）を作成
 * 将来の Function Calling 実装で使う
 *
 * Flutter は受信したら「調べ中...」のインジケーター表示などに使う
 *
 * estimatedSeconds: プログレスバー表示用、未指定なら省略
 */
function createToolCall({ tool, description, estimatedSeconds }) {
  const msg = {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.TOOL_CALL,
    tool: String(tool),
    description: String(description),
  };
  if (typeof estimatedSeconds === 'number') {
    msg.estimated_seconds = estimatedSeconds;
  }
  return msg;
}

/**
 * proactive_message（ライム発信）を作成
 * ユーザー入力なしにサーバー側から自発的に送るメッセージ
 *
 * trigger: 発信のきっかけ（'morning_greeting', 'late_night_warning' 等）
 *          ログ・分析用、Flutter ではUI影響なし
 */
function createProactive({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5, trigger }) {
  const msg = {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.PROACTIVE_MESSAGE,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
  if (trigger) msg.trigger = String(trigger);
  return msg;
}

/**
 * error メッセージを作成
 *
 * retriable: 同じリクエストを再送しても良いか（自動リトライの判断材料）
 * details: 本番では送らない、開発時のデバッグ情報のみ
 */
function createError({ code, message, retriable, details }) {
  const msg = {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.ERROR,
    code: String(code),
    message: String(message),
  };
  if (typeof retriable === 'boolean') msg.retriable = retriable;
  // 本番では details を送らない（情報漏洩防止）
  if (details && process.env.NODE_ENV !== 'production') msg.details = details;
  return msg;
}

/**
 * session_start メッセージを作成（v2新規）
 *
 * サーバーは WebSocket 接続確立時に必ずこれを送る。
 * Flutter は session_id を内部に保持し、以降の送信で含める。
 *
 * 「サーバーが発行 → Flutter が受け取る」一方向。
 * Flutter から session_id を指定して再接続することも可能（将来）
 */
function createSessionStart({ sessionId }) {
  return {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.SESSION_START,
    session_id: String(sessionId),
  };
}

// ─────────────────────────────────────────────
// LLM応答の正規化ユーティリティ
// ─────────────────────────────────────────────

/**
 * LLM（Gemma 等）が返す生の応答文字列を、chat メッセージに整える
 *
 * 処理内容:
 * 1. Markdown コードフェンス（```json ... ```）を剥がす
 *    → Gemma が時々これで包んで返してくる
 * 2. JSON パース
 *    → 失敗したら error メッセージを返す
 * 3. text / emotion / intensity を取り出して chat メッセージに組み立て
 *    → 各フィールドが欠けても createChat 側のデフォルトで補完される
 *
 * これがあることで:
 * - server.js は「Gemma の癖」を知らずに済む
 * - パース失敗時のエラーハンドリングが統一される
 *
 * @param {string} rawLLMOutput Gemma が返した生のテキスト
 * @returns {Object} chat メッセージ or error メッセージ
 */
function normalizeLLMOutput(rawLLMOutput) {
  if (typeof rawLLMOutput !== 'string') {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答が文字列ではありません',
      retriable: true,
    });
  }

  // Markdown コードフェンス除去
  // Gemma が ```json {...} ``` で包んで返してくることへの対策
  const cleaned = rawLLMOutput
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // JSON パース失敗 → エラーとして返す
    // details は本番では送られない（createError 内で制御）
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答のJSONパースに失敗しました',
      retriable: true,
      details: { rawOutput: rawLLMOutput, parseError: e.message },
    });
  }

  // chat メッセージとして組み立て
  // 欠けたフィールドは createChat のデフォルト値で補完される
  return createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });
}

// ─────────────────────────────────────────────
// 上りメッセージのバリデーション
// ─────────────────────────────────────────────

/**
 * Flutter から来た上りメッセージが正しい形式か検証する
 * - JSON オブジェクトか
 * - text フィールドが文字列で空でないか
 *
 * 不正なら createError() でエラーを返せるよう、エラー文を含めて返す
 */
function validateUpstream(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Message is not an object' };
  }
  if (typeof data.text !== 'string' || data.text.length === 0) {
    return { valid: false, error: 'text field is required and must be a non-empty string' };
  }
  return { valid: true, message: data };
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  // 定数
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  TOOLS,
  // ファクトリ関数
  createChat,
  createFiller,
  createToolCall,
  createProactive,
  createError,
  createSessionStart,
  // ユーティリティ
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};