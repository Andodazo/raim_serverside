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

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン（コード内のみ、JSON 出力には含めない）
// ─────────────────────────────────────────────
const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// type 列挙
// ─────────────────────────────────────────────

const MESSAGE_TYPES = Object.freeze({
  // 既存
  CHAT: 'chat',                      // 通常の一括応答（非ストリーミング、互換用）
  FILLER_AUDIO: 'filler_audio',      // つなぎ言葉
  TOOL_CALL: 'tool_call',            // ツール実行通知（将来実装）
  PROACTIVE_MESSAGE: 'proactive_message', // ライム発信（将来実装）
  ERROR: 'error',                    // エラー通知
  SESSION_START: 'session_start',    // セッション開始通知

  // ストリーミング応答用（新規）
  METADATA: 'metadata',              // 応答メタデータ即時通知（emotion/intensity 先送り）
  TEXT_CHUNK: 'text_chunk',          // 応答テキストのチャンク
  CHAT_END: 'chat_end',              // 応答完了通知
});

// ─────────────────────────────────────────────
// emotion 列挙
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// error コード列挙
// ─────────────────────────────────────────────

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
// マルチモーダル制約値
// ─────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGES_PER_MESSAGE = 10;

// ─────────────────────────────────────────────
// ヘルパ
// ─────────────────────────────────────────────

function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ─────────────────────────────────────────────
// ファクトリ関数（既存・互換用）
// ─────────────────────────────────────────────

/**
 * chat メッセージ（一括応答、非ストリーミング）
 * ストリーミング応答の場合は createMetadata + createTextChunk + createChatEnd を使う
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
// ファクトリ関数（ストリーミング用、新規）
// ─────────────────────────────────────────────

/**
 * metadata メッセージ（応答開始時の即時通知）
 *
 * Flutter は受信したら:
 * - emotion / intensity を Unity に送信して表情切替
 * - TTS パイプラインを準備（今回はテキストチャンクごとに合成）
 * - 空の吹き出しを UI に追加して text_chunk を待ち構える
 *
 * シーン判定の default_emotion / default_intensity を即時に送ることで、
 * LLM 推論完了を待たずに「ライムが反応してる」体験を提供する
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
 * 句読点や一定文字数で区切られたテキストの断片を送る。
 * Flutter は受信したら:
 * - 既存の吹き出しに text を追加表示
 * - 同時に VOICEVOX へ合成依頼を発行
 * - WAV を順次キューイングして再生
 *
 * is_first: 最初のチャンクかどうか（Flutter 側で吹き出し初期化判定に使う）
 */
function createTextChunk({ text, isFirst = false }) {
  const msg = {
    type: MESSAGE_TYPES.TEXT_CHUNK,
    text: String(text || ''),
  };
  if (isFirst) msg.is_first = true;
  return msg;
}

/**
 * chat_end メッセージ（応答完了通知）
 *
 * Flutter は受信したら:
 * - text_chunk の蓄積完了
 * - 履歴記録は不要（サーバー側で完結）
 * - TTS キューが残ってる場合は再生継続
 *
 * full_text: 全テキストを連結したもの（履歴表示・コピー用）
 * emotion / intensity: 最終的な確定値（metadata と同じ場合がほとんどだが、LLM 応答で変わる場合もある）
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
// LLM応答の正規化ユーティリティ（非ストリーミング時のみ使用）
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
// バリデーション（既存と同じ、マルチモーダル対応含む）
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

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  TOOLS,
  SUPPORTED_IMAGE_TYPES,
  MAX_TOTAL_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  // 既存ファクトリ
  createChat,
  createFiller,
  createToolCall,
  createProactive,
  createError,
  createSessionStart,
  // ストリーミング用ファクトリ
  createMetadata,
  createTextChunk,
  createChatEnd,
  // ユーティリティ
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};