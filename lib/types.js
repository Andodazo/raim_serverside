// lib/types.js
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

// 【v8 での変更点】
// - emotions フィールド追加（複数感情をオブジェクトで表現）
// - emotion + intensity も残す（後方互換、ドミナント感情を自動計算）
// - createTextChunk に isFiller オプション追加
// - createFiller 廃止（filler は text_chunk + isFiller:true で表現）
//
// 【emotions の構造】
// オブジェクト形式: {"happy": 0.7, "caring": 0.3}
// - 値は 0.0〜1.0、強さを表す
// - 0 の感情は省略可能（トークン節約）
// - 各感情の合計は必ずしも 1.0 にならない（独立した強さ）
//
// 【emotion + intensity（後方互換）】
// emotions のドミナント（最も強い）感情を自動的に入れる:
//   emotions: {"happy": 0.7, "caring": 0.3}
//   → emotion: "happy", intensity: 0.7
// Flutter 側で emotions に対応してない実装は emotion + intensity だけ見れば従来通り動く

'use strict';

const SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',  // 廃止予定だが定数は残す（後方互換）
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

// 全感情のリスト（バリデーション用）
const ALL_EMOTIONS = Object.freeze([
  'neutral', 'happy', 'sad', 'angry', 'surprised',
  'caring', 'embarrassed', 'excited',
]);

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
// 感情処理ヘルパ（v8 新規）
// ─────────────────────────────────────────────

/**
 * emotions オブジェクトから最も強い感情（ドミナント）を取得
 * 後方互換用の emotion + intensity を自動算出するために使う
 *
 * @param {Object|null} emotions {"happy": 0.7, "caring": 0.3} 形式
 * @returns {{emotion: string, intensity: number}}
 */
function getDominantEmotion(emotions) {
  if (!emotions || typeof emotions !== 'object') {
    return { emotion: 'neutral', intensity: 0.5 };
  }

  let dominant = { emotion: 'neutral', intensity: 0 };
  for (const [key, value] of Object.entries(emotions)) {
    if (!ALL_EMOTIONS.includes(key)) continue;
    if (typeof value !== 'number') continue;
    if (value > dominant.intensity) {
      dominant = { emotion: key, intensity: clampIntensity(value) };
    }
  }

  // 全部 0 だった場合は neutral 扱い
  if (dominant.intensity === 0) {
    return { emotion: 'neutral', intensity: 0.5 };
  }
  return dominant;
}

/**
 * emotions オブジェクトを正規化（不明な感情を除外、値をクランプ）
 */
function normalizeEmotions(emotions) {
  if (!emotions || typeof emotions !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(emotions)) {
    if (!ALL_EMOTIONS.includes(key)) continue;
    if (typeof value !== 'number') continue;
    const clamped = clampIntensity(value);
    if (clamped > 0) {
      normalized[key] = clamped;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * emotion + intensity の単一指定から emotions オブジェクトを作る
 * 既存実装の互換性のため
 */
function emotionToEmotions(emotion, intensity) {
  const emo = emotion || 'neutral';
  const int = clampIntensity(intensity);
  return { [emo]: int };
}

// ─────────────────────────────────────────────
// ファクトリ関数（既存・互換用）
// ─────────────────────────────────────────────

/**
 * chat メッセージ（非ストリーミング応答時のみ使用）
 *
 * 入力は emotion + intensity または emotions（または両方）
 * 出力には両方含める（後方互換）
 */
function createChat({ text, emotion, intensity, emotions }) {
  // emotions が指定されてればそれを使う、なければ emotion + intensity から作る
  let emotionsObj = normalizeEmotions(emotions);
  if (!emotionsObj) {
    emotionsObj = emotionToEmotions(emotion, intensity);
  }
  const dominant = getDominantEmotion(emotionsObj);

  return {
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: dominant.emotion,
    intensity: dominant.intensity,
    emotions: emotionsObj,
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

function createProactive({ text, emotion, intensity, emotions, trigger }) {
  let emotionsObj = normalizeEmotions(emotions);
  if (!emotionsObj) {
    emotionsObj = emotionToEmotions(emotion, intensity);
  }
  const dominant = getDominantEmotion(emotionsObj);

  const msg = {
    type: MESSAGE_TYPES.PROACTIVE_MESSAGE,
    text: String(text || ''),
    emotion: dominant.emotion,
    intensity: dominant.intensity,
    emotions: emotionsObj,
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
 * シーン default_emotions から計算した emotions を即時送信
 */
function createMetadata({ emotion, intensity, emotions, sceneId = null }) {
  let emotionsObj = normalizeEmotions(emotions);
  if (!emotionsObj) {
    emotionsObj = emotionToEmotions(emotion, intensity);
  }
  const dominant = getDominantEmotion(emotionsObj);

  const msg = {
    type: MESSAGE_TYPES.METADATA,
    emotion: dominant.emotion,
    intensity: dominant.intensity,
    emotions: emotionsObj,
  };
  if (sceneId) msg.scene_id = String(sceneId);
  return msg;
}

/**
 * text_chunk メッセージ（応答テキストのチャンク）
 *
 * v8: isFiller オプション追加
 * filler セリフ（つなぎ言葉、ツール呼出前の前置き）は isFiller: true をつける
 * Flutter は UI で「薄く表示」「ログから除外」など差別化可能
 */
function createTextChunk({ text, chunkId, isFirst = false, isFiller = false }) {
  const msg = {
    type: MESSAGE_TYPES.TEXT_CHUNK,
    text: String(text || ''),
    chunk_id: String(chunkId),
  };
  if (isFirst) msg.is_first = true;
  if (isFiller) msg.is_filler = true;
  return msg;
}

/**
 * audio_chunk メッセージ（音声データのチャンク）
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
 */
function createChatEnd({ fullText, emotion, intensity, emotions }) {
  let emotionsObj = normalizeEmotions(emotions);
  if (!emotionsObj) {
    emotionsObj = emotionToEmotions(emotion, intensity);
  }
  const dominant = getDominantEmotion(emotionsObj);

  return {
    type: MESSAGE_TYPES.CHAT_END,
    full_text: String(fullText || ''),
    emotion: dominant.emotion,
    intensity: dominant.intensity,
    emotions: emotionsObj,
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

  // emotions と emotion + intensity のどちらでも入力可能
  const chat = createChat({
    text: parsed.text || '',
    emotion: parsed.emotion,
    intensity: parsed.intensity,
    emotions: parsed.emotions,
  });

  if (parsed.image_description && typeof parsed.image_description === 'string') {
    chat._imageDescription = String(parsed.image_description);
  }

  return chat;
}

// ─────────────────────────────────────────────
// バリデーション
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
  ALL_EMOTIONS,
  ERROR_CODES,
  TOOLS,
  SUPPORTED_IMAGE_TYPES,
  MAX_TOTAL_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  // ファクトリ
  createChat,
  createToolCall,
  createProactive,
  createError,
  createSessionStart,
  createMetadata,
  createTextChunk,
  createAudioChunk,
  createChatEnd,
  // ヘルパ
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
  getDominantEmotion,
  normalizeEmotions,
  emotionToEmotions,
};