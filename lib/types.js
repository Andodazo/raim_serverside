// lib/types.js
// ==============================================================================
// WebSocket メッセージの型定義 + ファクトリ関数（version 除外版）
// ==============================================================================
//
// 【このファイルの役割】
// サーバー(Node.js) と Flutter の間で WebSocket 上を流れる JSON メッセージの
// 型・定数・組立関数を一元管理する。
//
// 【v4 での変更点】
// - JSON 出力から version フィールドを除去
// - 必要になったら復活させられるよう、SCHEMA_VERSION 定数自体はコード内に保持
//
// 【スキーマ仕様の正本】
// docs/json-schema.md, docs/multimodal-spec.md
// ==============================================================================
// WebSocket メッセージの型定義 + ファクトリ関数（ストリーミング対応版）
// ==============================================================================
//
// 【このファイルの役割】
// サーバー(Node.js) と Flutter の間で WebSocket 上を流れる JSON メッセージの
// 型・定数・組立関数を一元管理する。
//
// 【v5 での変更点】
// - ストリーミング応答用に METADATA / TEXT_CHUNK / CHAT_END タイプを追加
// - createMetadata / createTextChunk / createChatEnd ファクトリ関数を追加
// - 既存の createChat 等は後方互換のため残す（非ストリーミング応答時に使用）

// 【v7 での変更点】
// - voice_params フィールドを全てのメッセージから削除（サーバー内部のみで使用）
// - audio_chunk タイプを新規追加（Base64 エンコードされた WAV を送信）
// - text_chunk に chunk_id を追加（audio_chunk と紐付け）
//
// 【設計判断】
// AWS API Gateway WebSocket がバイナリフレーム非対応のため、
// WAV は Base64 でテキストとしてJSONに含めて送信する。
// ローカル(ws) と本番(API Gateway) で同じコードが動く。

'use strict';

const SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',
  TOOL_CALL: 'tool_call',
  PROACTIVE_MESSAGE: 'proactive_message',
  ERROR: 'error',
  SESSION_START: 'session_start',
  METADATA: 'metadata',
  TEXT_CHUNK: 'text_chunk',
  AUDIO_CHUNK: 'audio_chunk',
  CHAT_END: 'chat_end',
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
  TTS_ERROR: 'TTS_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  MAINTENANCE: 'MAINTENANCE',
});

const TOOLS = Object.freeze({
  WEB_SEARCH: 'web_search',
});

const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 10;

function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ─────────────────────────────────────────────
// ファクトリ関数（既存・互換用）
// ─────────────────────────────────────────────

/**
 * chat メッセージ（一括応答、非ストリーミング時のみ使用）
 * ストリーミング応答時は metadata + text_chunk + audio_chunk + chat_end を使う
 */
function createChat({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

function createFiller({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    type: MESSAGE_TYPES.FILLER_AUDIO,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

function createToolCall({ tool, description, estimatedSeconds }) {
  const msg = {
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
    type: MESSAGE_TYPES.ERROR,
    code: String(code),
    message: String(message),
  };
  if (typeof retriable === 'boolean') msg.retriable = retriable;
  if (details && process.env.NODE_ENV !== 'production') msg.details = details;
  return msg;
}

function createSessionStart({ sessionId }) {
  return {
    type: MESSAGE_TYPES.SESSION_START,
    session_id: String(sessionId),
  };
}

// ─────────────────────────────────────────────
// ファクトリ関数（ストリーミング用）
// ─────────────────────────────────────────────

/**
 * metadata メッセージ（応答開始時の即時通知）
 *
 * Flutter は受信したら:
 * - emotion / intensity を Unity に送信して表情切替
 * - 空の吹き出しを UI に追加
 * - 音声再生キューを初期化
 */
function createMetadata({ emotion = EMOTIONS.NEUTRAL, intensity = 0.5, sceneId = null }) {
  const msg = {
    type: MESSAGE_TYPES.METADATA,
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
  if (sceneId) msg.scene_id = String(sceneId);
  return msg;
}

/**
 * text_chunk メッセージ（応答テキストのチャンク）
 *
 * chunk_id: audio_chunk と紐付けるための識別子
 *           Flutter は chunk_id でテキスト表示と音声再生を同期できる
 *           （ただし基本は到着順で表示すればOK、chunk_id は順序保証のため）
 */
function createTextChunk({ text, chunkId, isFirst = false }) {
  const msg = {
    type: MESSAGE_TYPES.TEXT_CHUNK,
    text: String(text || ''),
    chunk_id: String(chunkId),
  };
  if (isFirst) msg.is_first = true;
  return msg;
}

/**
 * audio_chunk メッセージ（音声データのチャンク）
 *
 * VOICEVOX で合成された WAV を Base64 エンコードして送信。
 * Flutter は受信したら Base64 デコードして再生キューに追加。
 *
 * chunk_id: text_chunk と対応する識別子
 *           同じ chunk_id を持つ text/audio がペア
 */
function createAudioChunk({ chunkId, audioBase64, format = 'wav' }) {
  return {
    type: MESSAGE_TYPES.AUDIO_CHUNK,
    chunk_id: String(chunkId),
    format: String(format),
    audio: String(audioBase64),
  };
}

/**
 * chat_end メッセージ（応答完了通知）
 *
 * Flutter は受信したら:
 * - text_chunk の蓄積完了
 * - 残った audio_chunk が再生キューにある場合は継続再生
 * - emotion / intensity の最終確定値を反映
 */
function createChatEnd({ fullText, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    type: MESSAGE_TYPES.CHAT_END,
    full_text: String(fullText || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
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

  const chat = createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });

  if (parsed.image_description && typeof parsed.image_description === 'string') {
    chat._imageDescription = String(parsed.image_description);
  }

  return chat;
}

// ─────────────────────────────────────────────
// バリデーション（既存）
// ─────────────────────────────────────────────

function validateUpstream(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Message is not an object' };
  }
  if (typeof data.text !== 'string') {
    return { valid: false, error: 'text field is required and must be a string' };
  }
  if (data.images === undefined || data.images === null) {
    return { valid: true, message: data };
  }
  if (!Array.isArray(data.images)) {
    return { valid: false, error: 'images must be an array' };
  }
  if (data.images.length === 0) {
    return { valid: true, message: data };
  }
  if (data.images.length > MAX_IMAGES_PER_MESSAGE) {
    return { valid: false, error: `Too many images (max ${MAX_IMAGES_PER_MESSAGE})` };
  }

  let totalSize = 0;
  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];
    if (!img || typeof img !== 'object') {
      return { valid: false, error: `images[${i}] must be an object` };
    }
    if (typeof img.data !== 'string' || img.data.length === 0) {
      return { valid: false, error: `images[${i}].data must be a non-empty Base64 string` };
    }
    if (!SUPPORTED_IMAGE_TYPES.includes(img.media_type)) {
      return {
        valid: false,
        error: `Unsupported media_type: ${img.media_type}. Supported: ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
      };
    }
    totalSize += Math.floor(img.data.length * 0.75);
  }

  if (totalSize > MAX_TOTAL_IMAGE_SIZE) {
    return {
      valid: false,
      error: `Total image size exceeds limit (${Math.floor(totalSize / 1024)}KB > ${MAX_TOTAL_IMAGE_SIZE / 1024 / 1024}MB)`,
    };
  }

  return { valid: true, message: data };
}

module.exports = {
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  TOOLS,
  SUPPORTED_IMAGE_TYPES,
  MAX_TOTAL_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  createChat,
  createFiller,
  createToolCall,
  createProactive,
  createError,
  createSessionStart,
  createMetadata,
  createTextChunk,
  createAudioChunk,
  createChatEnd,
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};