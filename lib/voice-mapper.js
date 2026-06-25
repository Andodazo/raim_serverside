// lib/voice-mapper.js
// ==============================================================================
// emotion から VOICEVOX の voice params を計算する（D-2 サーバー内部用）
// ==============================================================================
//
// 【D-2 での役割変更】
// 旧設計: voice_params を JSON で Flutter に送る → Flutter が VOICEVOX 呼出
// 新設計: voice_params はサーバー内部で TTS 呼出時に使う → Flutter には送らない
//
// インターフェース（loadVoiceConfig / getVoiceParams）は同じなので、
// 呼び出し側（旧: types.js → 新: server.js から tts.js への呼出）が変わるだけ。
//
// 【voice-config.json はそのまま使える】
// プロファイル定義は変わらず、emotion → speaker_id + パラメータのマッピング
// .env の RAIM_VOICE_PROFILE でアクティブプロファイル切替

// 【v9 での変更点】
// - emotions オブジェクト（複数感情）入力に対応
// - ドミナント感情を計算して、その emotion + intensity で voice_params 算出
// - 既存の getVoiceParams(emotion, intensity) も維持（後方互換）
//
// 【TTS 設計判断】
// TTS は「ドミナント感情ベース」を維持。理由:
// - speaker_id は離散値（スタイル切替）なので、複数感情の補間が困難
// - パラメータの加重平均は可能だが、効果が薄く実装複雑度に見合わない
// - Unity の BlendShape は本来複数表情ブレンド前提なので、そちらで活かす

'use strict';

const fs = require('fs');
const path = require('path');
const { getDominantEmotion } = require('./types');

let VOICE_CONFIG = null;
let ACTIVE_PROFILE = null;
let ACTIVE_PROFILE_NAME = null;

function loadVoiceConfig() {
  const configPath = path.join(__dirname, '..', 'voice-config.json');

  if (!fs.existsSync(configPath)) {
    console.warn('[VoiceMapper] voice-config.json not found');
    console.warn('  TTS will use default speaker_id=8 (春日部つむぎ ノーマル)');
    return false;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    VOICE_CONFIG = JSON.parse(raw);
  } catch (e) {
    console.error(`[VoiceMapper] Failed to parse voice-config.json: ${e.message}`);
    return false;
  }

  ACTIVE_PROFILE_NAME = process.env.RAIM_VOICE_PROFILE || VOICE_CONFIG.active_profile;
  ACTIVE_PROFILE = VOICE_CONFIG.profiles[ACTIVE_PROFILE_NAME];

  if (!ACTIVE_PROFILE) {
    console.error(`[VoiceMapper] Profile "${ACTIVE_PROFILE_NAME}" not found`);
    console.error(`  Available profiles: ${Object.keys(VOICE_CONFIG.profiles).join(', ')}`);
    return false;
  }

  console.log(`\u2713 Voice profile loaded: ${ACTIVE_PROFILE_NAME} (${ACTIVE_PROFILE.speaker_name})`);
  console.log(`  ${ACTIVE_PROFILE.description}`);
  return true;
}

// ─────────────────────────────────────────────
// メイン関数（後方互換版）
// ─────────────────────────────────────────────

/**
 * emotion + intensity から voice_params を取得（既存インターフェース）
 *
 * @param {string} emotion ('neutral', 'happy', etc.)
 * @param {number} intensity (0.0〜1.0)
 * @returns {Object} { speaker_id, speedScale, pitchScale, intonationScale, volumeScale }
 */
function getVoiceParams(emotion = 'neutral', intensity = 0.5) {
  if (!ACTIVE_PROFILE) {
    return defaultVoiceParams();
  }

  const emotionMap = ACTIVE_PROFILE.emotion_map;
  const targetParams = emotionMap[emotion] || emotionMap['neutral'];
  const neutralParams = emotionMap['neutral'];

  if (!targetParams || !neutralParams) {
    console.warn(`[VoiceMapper] Missing emotion_map for "${emotion}" or "neutral"`);
    return defaultVoiceParams();
  }

  const speaker_id = targetParams.speaker_id;
  const safeIntensity = Math.max(0, Math.min(1, intensity));

  const lerp = (key) => {
    const n = neutralParams[key] ?? 1.0;
    const t = targetParams[key] ?? n;
    return n + (t - n) * safeIntensity;
  };

  return {
    speaker_id,
    speedScale: round3(lerp('speedScale')),
    pitchScale: round3(lerp('pitchScale')),
    intonationScale: round3(lerp('intonationScale')),
    volumeScale: round3(lerp('volumeScale')),
  };
}

/**
 * emotions オブジェクトから voice_params を取得（v9 新規）
 *
 * 複数感情の場合、ドミナント感情ベースで計算する。
 * 将来的に加重平均ブレンドする余地もあるが、現状は単純化。
 *
 * @param {Object} emotions {"happy": 0.7, "caring": 0.3} 形式
 * @returns {Object} voice_params
 */
function getVoiceParamsFromEmotions(emotions) {
  const dominant = getDominantEmotion(emotions);
  return getVoiceParams(dominant.emotion, dominant.intensity);
}

// ─────────────────────────────────────────────
// 内部ヘルパ
// ─────────────────────────────────────────────

function defaultVoiceParams() {
  return {
    speaker_id: 8,  // 春日部つむぎ ノーマル
    speedScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    volumeScale: 1.0,
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function getActiveProfileName() {
  return ACTIVE_PROFILE_NAME;
}

function getActiveProfileInfo() {
  if (!ACTIVE_PROFILE) return null;
  return {
    name: ACTIVE_PROFILE_NAME,
    speaker_name: ACTIVE_PROFILE.speaker_name,
    description: ACTIVE_PROFILE.description,
    default_speaker_id: ACTIVE_PROFILE.default_speaker_id,
  };
}

module.exports = {
  loadVoiceConfig,
  getVoiceParams,
  getVoiceParamsFromEmotions,
  getActiveProfileName,
  getActiveProfileInfo,
};