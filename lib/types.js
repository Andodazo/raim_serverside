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

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン（コード内のみ、JSON 出力には含めない）
// ─────────────────────────────────────────────
//
// 将来、破壊的変更が必要になった時に JSON 出力に含めるよう復活させる予定。
// その時は createXxx() 関数の戻り値オブジェクトに version: SCHEMA_VERSION を追加する。
const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// type 列挙
// ─────────────────────────────────────────────

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  FILLER_AUDIO: 'filler_audio',
  TOOL_CALL: 'tool_call',
  PROACTIVE_MESSAGE: 'proactive_message',
  ERROR: 'error',
  SESSION_START: 'session_start',
});

// ─────────────────────────────────────────────
// emotion 列挙
// ─────────────────────────────────────────────
//
// Unity 立ち絵に対応する基本5種 + 拡張値
// Unity 側は未対応値が来た場合 default にフォールバックする

const EMOTIONS = Object.freeze({
  // Unity 立ち絵 5 種
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  SURPRISED: 'surprised',
  // 拡張値（Unity 立ち絵未対応時は default にフォールバック）
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

// 全画像合計の上限（Base64 化前のバイト数換算）
const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// 1メッセージあたりの最大画像数
const MAX_IMAGES_PER_MESSAGE = 10;

// ─────────────────────────────────────────────
// ファクトリ関数
// ─────────────────────────────────────────────

/**
 * intensity を 0.0〜1.0 にクランプ
 * NaN や undefined が来たら 0.5 を返す
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
 * - チャットUIには追加しない（chat と違うポイント）
 * - 音声だけ再生して「考えてる感」を演出
 *
 * 検索や重い処理の前に即送ることで体感レイテンシを下げる
 */
function createFiller({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
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
 */
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

/**
 * proactive_message（ライム発信）を作成
 * ユーザー入力なしにサーバー側から自発的に送るメッセージ
 *
 * trigger: 発信のきっかけ（'morning_greeting', 'late_night_warning' 等）
 *          ログ・分析用、Flutter ではUI影響なし
 */
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

/**
 * error メッセージを作成
 *
 * retriable: 同じリクエストを再送しても良いか（自動リトライの判断材料）
 * details: 本番では送らない、開発時のデバッグ情報のみ
 */
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

/**
 * session_start メッセージを作成
 *
 * サーバーは WebSocket 接続確立時に必ずこれを送る。
 * Flutter は session_id を内部保持し、以降の send に含める。
 */
function createSessionStart({ sessionId }) {
  return {
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
 * 2. JSON パース
 * 3. text / emotion / intensity を取り出して chat メッセージに組み立て
 * 4. image_description があれば _imageDescription として内部保持
 *    （アンダースコア prefix で「内部用フィールド」と区別、
 *      server.js 側で Flutter 送信時に明示的に削除する）
 *
 * @param {string} rawLLMOutput
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
  const chat = createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });

  // image_description があれば内部用フィールドとして保持
  // _ prefix で「内部用、Flutter には送らない」を示す
  if (parsed.image_description && typeof parsed.image_description === 'string') {
    chat._imageDescription = String(parsed.image_description);
  }

  return chat;
}

// ─────────────────────────────────────────────
// バリデーション（マルチモーダル対応）
// ─────────────────────────────────────────────

/**
 * 上りメッセージのバリデーション
 *
 * チェック内容:
 * - data がオブジェクトか
 * - text フィールドが存在するか（空文字でも OK、画像のみ送信時のため）
 * - images が配列なら各要素が {data, media_type} 構造か
 * - images の枚数・合計サイズが上限内か
 * - media_type が対応形式か
 */
function validateUpstream(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Message is not an object' };
  }

  // text は文字列であればOK（空文字でも、画像のみ送信のケースで許容）
  if (typeof data.text !== 'string') {
    return { valid: false, error: 'text field is required and must be a string' };
  }

  // images が指定されていなければここで終了
  if (data.images === undefined || data.images === null) {
    return { valid: true, message: data };
  }

  // images があるなら配列でなければNG
  if (!Array.isArray(data.images)) {
    return { valid: false, error: 'images must be an array' };
  }

  // images が空配列なら通す（クライアントの実装簡略化のため）
  if (data.images.length === 0) {
    return { valid: true, message: data };
  }

  // 枚数上限
  if (data.images.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      valid: false,
      error: `Too many images (max ${MAX_IMAGES_PER_MESSAGE})`,
    };
  }

  // 画像のみ送信の場合は text 空文字でOK
  // ただし、text が空 + images も空はNG（既に上で images.length === 0 を通してるので、ここには来ない）

  // 各画像のチェック
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

    // Base64 文字列のおおよそのバイト数（4/3 デコード比率の逆算）
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
  // 定数
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  TOOLS,
  SUPPORTED_IMAGE_TYPES,
  MAX_TOTAL_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
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