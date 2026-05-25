// lib/types.js
// RAiM WebSocket メッセージの型定義（JSDoc形式）
//
// このファイルは「サーバー側コードでメッセージ構造を一元管理する」ためのもの。
// 詳細仕様は docs/json-schema.md を参照。
//
// 使い方:
//   const { createChat, createFiller, EMOTIONS, ERROR_CODES } = require('./lib/types');
//   ws.send(JSON.stringify(createChat({ text: "おはよう", emotion: "happy", intensity: 0.8 })));

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン
// ─────────────────────────────────────────────

const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// 型定数
// ─────────────────────────────────────────────

/**
 * メッセージ type の列挙
 */
const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',
  TOOL_CALL: 'tool_call',
  PROACTIVE_MESSAGE: 'proactive_message',
  ERROR: 'error',
});

/**
 * emotion の許容値
 * Unity 立ち絵に対応する基本5種 + 拡張値
 * Unity 側は未対応値が来た場合 default にフォールバックする
 */
const EMOTIONS = Object.freeze({
  // Unity 立ち絵 5 種
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  SURPRISED: 'surprised',
  // 拡張値（Unity未対応時はdefaultにフォールバック）
  CARING: 'caring',
  EMBARRASSED: 'embarrassed',
  EXCITED: 'excited',
});

/**
 * error コードの列挙
 */
const ERROR_CODES = Object.freeze({
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_ERROR: 'LLM_ERROR',
  EMBED_ERROR: 'EMBED_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  MAINTENANCE: 'MAINTENANCE',
});

/**
 * tool_call のツール名の列挙
 */
const TOOLS = Object.freeze({
  WEB_SEARCH: 'web_search',
  // 将来追加予定: CALENDAR, CAMERA, etc.
});

// ─────────────────────────────────────────────
// JSDoc 型定義
// ─────────────────────────────────────────────

/**
 * 上り（Flutter → サーバー）メッセージ
 * @typedef {Object} UpstreamMessage
 * @property {string} text - ユーザーが入力したテキスト
 * @property {string} [image] - 将来：カメラ画像（base64）
 * @property {string} [client_time] - 将来：クライアント時刻（ISO8601）
 */

/**
 * 下りメッセージの共通フィールド
 * @typedef {Object} BaseDownstreamMessage
 * @property {number} version - スキーマバージョン（現行は1）
 * @property {string} type - メッセージ種別
 */

/**
 * chat 型メッセージ
 * @typedef {BaseDownstreamMessage} ChatMessage
 * @property {'chat'} type
 * @property {string} text - ライムの発言内容
 * @property {string} emotion - 感情ラベル（EMOTIONS のいずれか）
 * @property {number} intensity - 感情強度 0.0〜1.0
 */

/**
 * filler_audio 型メッセージ
 * @typedef {BaseDownstreamMessage} FillerAudioMessage
 * @property {'filler_audio'} type
 * @property {string} text - つなぎセリフ
 * @property {string} emotion - 感情ラベル
 * @property {number} intensity - 感情強度
 */

/**
 * tool_call 型メッセージ
 * @typedef {BaseDownstreamMessage} ToolCallMessage
 * @property {'tool_call'} type
 * @property {string} tool - ツール名（TOOLS のいずれか）
 * @property {string} description - ユーザー向け説明
 * @property {number} [estimated_seconds] - 推定秒数
 */

/**
 * proactive_message 型メッセージ
 * @typedef {BaseDownstreamMessage} ProactiveMessage
 * @property {'proactive_message'} type
 * @property {string} text - ライムの発言
 * @property {string} emotion - 感情ラベル
 * @property {number} intensity - 感情強度
 * @property {string} [trigger] - 発信トリガー識別子
 */

/**
 * error 型メッセージ
 * @typedef {BaseDownstreamMessage} ErrorMessage
 * @property {'error'} type
 * @property {string} code - エラーコード（ERROR_CODES のいずれか）
 * @property {string} message - ユーザー向けエラーメッセージ
 * @property {boolean} [retriable] - 再試行可能か
 * @property {Object} [details] - デバッグ用詳細（本番では送らない）
 */

// ─────────────────────────────────────────────
// ファクトリ関数
// 各 type のメッセージを生成する。version は自動付与。
// ─────────────────────────────────────────────

/**
 * intensity を 0.0〜1.0 にクランプ
 * @param {number} v
 * @returns {number}
 */
function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * chat メッセージを作成
 * @param {{text: string, emotion?: string, intensity?: number}} params
 * @returns {ChatMessage}
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
 * filler_audio メッセージを作成
 * @param {{text: string, emotion?: string, intensity?: number}} params
 * @returns {FillerAudioMessage}
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
 * tool_call メッセージを作成
 * @param {{tool: string, description: string, estimatedSeconds?: number}} params
 * @returns {ToolCallMessage}
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
 * proactive_message メッセージを作成
 * @param {{text: string, emotion?: string, intensity?: number, trigger?: string}} params
 * @returns {ProactiveMessage}
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
 * @param {{code: string, message: string, retriable?: boolean, details?: Object}} params
 * @returns {ErrorMessage}
 */
function createError({ code, message, retriable, details }) {
  const msg = {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.ERROR,
    code: String(code),
    message: String(message),
  };
  if (typeof retriable === 'boolean') msg.retriable = retriable;
  if (details && process.env.NODE_ENV !== 'production') msg.details = details;
  return msg;
}

// ─────────────────────────────────────────────
// LLM応答の正規化ユーティリティ
// Gemma が返す JSON を chat メッセージ形式に整える
// ─────────────────────────────────────────────

/**
 * Gemma などから返ってきた JSON 文字列を chat メッセージに正規化する。
 * Markdown のコードフェンスで包まれている場合は剥がす。
 * パースに失敗したら error メッセージを返す。
 *
 * @param {string} rawLLMOutput
 * @returns {ChatMessage | ErrorMessage}
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
  const cleaned = rawLLMOutput
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答のJSONパースに失敗しました',
      retriable: true,
      details: { rawOutput: rawLLMOutput, parseError: e.message },
    });
  }

  // chat メッセージとして組み立て
  return createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });
}

// ─────────────────────────────────────────────
// バリデーション
// ─────────────────────────────────────────────

/**
 * 上りメッセージのバリデーション
 * @param {*} data
 * @returns {{valid: boolean, error?: string, message?: UpstreamMessage}}
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

  // ユーティリティ
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};