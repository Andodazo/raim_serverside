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

// 【v9 での変更点】
// - 感情キーを 8種類 → 12種類に拡張
//   追加: curious, amused, thoughtful, playful
// - emotions の正規化（合計1.0）+ overall_intensity を導入
//   - emotions: 表情の配分（比率、合計1.0）
//   - overall_intensity: 全体の表情の強さ（0.0〜1.0）
//   - Unity 側 BlendShape 重み = emotions[key] × overall_intensity
// - emotion + intensity は後方互換で残す
//   - intensity = ドミナント感情の比率 × overall_intensity

'use strict';

const SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',  // 廃止、定数だけ残す
  TOOL_CALL: 'tool_call',
  PROACTIVE_MESSAGE: 'proactive_message',
  ERROR: 'error',
  SESSION_START: 'session_start',
  METADATA: 'metadata',
  TEXT_CHUNK: 'text_chunk',
  AUDIO_CHUNK: 'audio_chunk',
  CHAT_END: 'chat_end',
});

// 既存8感情
const EMOTIONS = Object.freeze({
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  SURPRISED: 'surprised',
  CARING: 'caring',
  EMBARRASSED: 'embarrassed',
  EXCITED: 'excited',
  // v9 追加 (4種)
  CURIOUS: 'curious',         // 好奇心、興味
  AMUSED: 'amused',           // くすっと笑い、軽い面白がり
  THOUGHTFUL: 'thoughtful',   // 思案、考え込む
  PLAYFUL: 'playful',         // からかい、いたずら
});

// 全12感情のリスト（バリデーション用）
const ALL_EMOTIONS = Object.freeze([
  'neutral', 'happy', 'sad', 'angry', 'surprised',
  'caring', 'embarrassed', 'excited',
  'curious', 'amused', 'thoughtful', 'playful',
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

function clamp01(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ─────────────────────────────────────────────
// 感情処理ヘルパ（v9 新規・更新）
// ─────────────────────────────────────────────

/**
 * 不明な感情を除外、値をクランプして整理した emotions を返す
 *
 * @param {Object|null} emotions
 * @returns {Object|null} 正規化前の整理済み emotions、空ならnull
 */
function sanitizeEmotions(emotions) {
  if (!emotions || typeof emotions !== 'object') return null;
  const cleaned = {};
  for (const [key, value] of Object.entries(emotions)) {
    if (!ALL_EMOTIONS.includes(key)) continue;
    if (typeof value !== 'number') continue;
    const clamped = clamp01(value);
    if (clamped > 0) {
      cleaned[key] = clamped;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * emotions を合計1.0 に正規化 + overall_intensity を算出
 *
 * 【ロジック】
 * - 入力例1: {"happy": 0.7, "caring": 0.3} → 合計1.0、変化なし、overall=1.0
 * - 入力例2: {"happy": 0.8} → 合計0.8、正規化{"happy":1.0}、overall=0.8
 * - 入力例3: {"happy": 1.0, "caring": 0.5} → 合計1.5、正規化{"happy":0.667,"caring":0.333}、overall=1.0
 * - 入力例4: {"happy": 0.3} → 合計0.3、正規化{"happy":1.0}、overall=0.3
 *
 * 【overall_intensity の意味】
 * - 1.0: 表情がフル強度
 * - 0.5: 表情が半分の強度（控えめ）
 * - Unity 側: BlendShape 重み = emotions[key] × overall_intensity
 *
 * @param {Object} emotions 入力
 * @returns {{emotions: Object, overall_intensity: number}}
 */
function normalizeAndComputeIntensity(emotions) {
  const cleaned = sanitizeEmotions(emotions);
  if (!cleaned) {
    return {
      emotions: { neutral: 1.0 },
      overall_intensity: 0.5,
    };
  }

  const sum = Object.values(cleaned).reduce((a, b) => a + b, 0);

  if (sum === 0) {
    return {
      emotions: { neutral: 1.0 },
      overall_intensity: 0,
    };
  }

  // overall_intensity = min(sum, 1.0)
  // 合計が 1.0 を超えてたら、全体強度は最大（1.0）
  // 合計が 1.0 未満なら、全体強度は合計と同じ（弱い表情）
  const overallIntensity = Math.min(1.0, sum);

  // 各感情を比率に変換（合計1.0）
  const normalized = {};
  for (const [key, value] of Object.entries(cleaned)) {
    normalized[key] = round3(value / sum);
  }

  return {
    emotions: normalized,
    overall_intensity: round3(overallIntensity),
  };
}

/**
 * emotions（正規化済み比率）と overall_intensity から、
 * ドミナント感情と互換用 intensity を取得
 *
 * 【後方互換】
 * 旧 emotion + intensity を見るコード向け:
 *   intensity = emotions[dominant] × overall_intensity
 * これにより「弱い表情の中で happy が支配的」も intensity に反映される
 */
function getDominantEmotion(emotions, overallIntensity = 1.0) {
  if (!emotions || typeof emotions !== 'object') {
    return { emotion: 'neutral', intensity: 0.5 };
  }

  let dominant = { emotion: 'neutral', ratio: 0 };
  for (const [key, value] of Object.entries(emotions)) {
    if (!ALL_EMOTIONS.includes(key)) continue;
    if (typeof value !== 'number') continue;
    if (value > dominant.ratio) {
      dominant = { emotion: key, ratio: clamp01(value) };
    }
  }

  if (dominant.ratio === 0) {
    return { emotion: 'neutral', intensity: 0.5 };
  }

  // 互換 intensity = ratio × overall_intensity
  const safeOverall = clamp01(overallIntensity);
  return {
    emotion: dominant.emotion,
    intensity: round3(dominant.ratio * safeOverall),
  };
}

/**
 * emotion + intensity の単一指定から emotions オブジェクトを作る
 * 旧クライアント・既存実装の互換性のため
 */
function emotionToEmotions(emotion, intensity) {
  const emo = emotion || 'neutral';
  const int = clampIntensity(intensity);
  return { [emo]: int };
}

/**
 * 入力フィールド（emotions or emotion+intensity）を統一的に処理し、
 * 正規化済み emotions と overall_intensity と互換 emotion+intensity を返す
 *
 * このヘルパを各ファクトリ関数で使う
 */
function resolveEmotionsInput({ emotions, emotion, intensity }) {
  // emotions 指定があればそれを優先、なければ emotion + intensity から作る
  let raw = sanitizeEmotions(emotions);
  if (!raw) {
    raw = emotionToEmotions(emotion, intensity);
  }
  const normalized = normalizeAndComputeIntensity(raw);
  const dominant = getDominantEmotion(normalized.emotions, normalized.overall_intensity);

  return {
    emotions: normalized.emotions,
    overall_intensity: normalized.overall_intensity,
    emotion: dominant.emotion,
    intensity: dominant.intensity,
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ─────────────────────────────────────────────
// ファクトリ関数
// ─────────────────────────────────────────────

function createChat({ text, emotion, intensity, emotions }) {
  const resolved = resolveEmotionsInput({ emotions, emotion, intensity });
  return {
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: resolved.emotion,
    intensity: resolved.intensity,
    emotions: resolved.emotions,
    overall_intensity: resolved.overall_intensity,
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
  const resolved = resolveEmotionsInput({ emotions, emotion, intensity });
  const msg = {
    type: MESSAGE_TYPES.PROACTIVE_MESSAGE,
    text: String(text || ''),
    emotion: resolved.emotion,
    intensity: resolved.intensity,
    emotions: resolved.emotions,
    overall_intensity: resolved.overall_intensity,
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

function createMetadata({ emotion, intensity, emotions, sceneId = null }) {
  const resolved = resolveEmotionsInput({ emotions, emotion, intensity });
  const msg = {
    type: MESSAGE_TYPES.METADATA,
    emotion: resolved.emotion,
    intensity: resolved.intensity,
    emotions: resolved.emotions,
    overall_intensity: resolved.overall_intensity,
  };
  if (sceneId) msg.scene_id = String(sceneId);
  return msg;
}

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

function createAudioChunk({ chunkId, audioBase64, format = 'wav' }) {
  return {
    type: MESSAGE_TYPES.AUDIO_CHUNK,
    chunk_id: String(chunkId),
    format: String(format),
    audio: String(audioBase64),
  };
}

function createChatEnd({ fullText, emotion, intensity, emotions }) {
  const resolved = resolveEmotionsInput({ emotions, emotion, intensity });
  return {
    type: MESSAGE_TYPES.CHAT_END,
    full_text: String(fullText || ''),
    emotion: resolved.emotion,
    intensity: resolved.intensity,
    emotions: resolved.emotions,
    overall_intensity: resolved.overall_intensity,
  };
}

// ─────────────────────────────────────────────
// LLM応答の正規化
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
  clamp01,
  // 感情処理（v9）
  sanitizeEmotions,
  normalizeAndComputeIntensity,
  getDominantEmotion,
  emotionToEmotions,
  resolveEmotionsInput,
};