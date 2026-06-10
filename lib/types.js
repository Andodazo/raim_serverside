// lib/types.js (v2 - session_start 対応)
//
// 変更点（v2）:
// - MESSAGE_TYPES に SESSION_START を追加
// - createSessionStart() ファクトリ関数を追加

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン
// ─────────────────────────────────────────────

const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// 型定数
// ─────────────────────────────────────────────

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',
  TOOL_CALL: 'tool_call',
  PROACTIVE_MESSAGE: 'proactive_message',
  ERROR: 'error',
  SESSION_START: 'session_start',  // ← v2 追加
});

const EMOTIONS = Object.freeze({
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  SURPRISED: 'surprised',
  CARING: 'caring',
  EMBARRASSED: 'embarrassed',
  EXCITED: 'excited',
});

const ERROR_CODES = Object.freeze({
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_ERROR: 'LLM_ERROR',
  EMBED_ERROR: 'EMBED_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  MAINTENANCE: 'MAINTENANCE',
});

const TOOLS = Object.freeze({
  WEB_SEARCH: 'web_search',
});

// ─────────────────────────────────────────────
// ファクトリ関数
// ─────────────────────────────────────────────

function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function createChat({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

function createFiller({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.FILLER_AUDIO,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

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

/**
 * セッション開始通知メッセージ（v2新規）
 * サーバーが接続時に Flutter に sessionID を伝える
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

function normalizeLLMOutput(rawLLMOutput) {
  if (typeof rawLLMOutput !== 'string') {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答が文字列ではありません',
      retriable: true,
    });
  }

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

  return createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });
}

// ─────────────────────────────────────────────
// バリデーション
// ─────────────────────────────────────────────

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
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  TOOLS,
  createChat,
  createFiller,
  createToolCall,
  createProactive,
  createError,
  createSessionStart,
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};