// lib/tts.js
// ==============================================================================
// VOICEVOX 呼出ライブラリ（D-2 TTS サーバー集約）
// ==============================================================================
//
// 【このファイルの役割】
// サーバー側で VOICEVOX に直接アクセスして、テキストを WAV に合成する。
// 旧設計では Flutter が VOICEVOX を叩いていたが、D-2 でサーバー集約に変更。
//
// 【AWS 移行時の見通し】
// 本番ではこのファイルの中身を:
//   - Lambda → EC2/ECS の VOICEVOX を VPC 内通信で叩く
//   - または専用の TTS マイクロサービス（ECS Service）を分離
// に書き換える。インターフェースは同じなので server.js 側は変更不要。
//
// 【VOICEVOX API のフロー】
// 1. POST /audio_query?text=...&speaker={id}  → AudioQuery JSON 取得
// 2. AudioQuery の speedScale/pitchScale/intonationScale/volumeScale を上書き
// 3. POST /synthesis?speaker={id} に AudioQuery を送る → WAV バイナリ取得
//
// 【エラー時の挙動】
// - VOICEVOX が落ちてる → エラーを throw（呼び出し側でハンドリング）
// - 合成失敗 → text_chunk だけ送って音声はスキップ（テキストは表示される）

'use strict';

const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://localhost:50021';

// ─────────────────────────────────────────────
// VOICEVOX 合成
// ─────────────────────────────────────────────

/**
 * テキストを VOICEVOX で合成して、WAV バイナリを返す
 *
 * @param {string} text 合成するテキスト
 * @param {Object} voiceParams 音声パラメータ
 *   - speaker_id: VOICEVOX のスピーカーID
 *   - speedScale: 話速
 *   - pitchScale: 音高
 *   - intonationScale: 抑揚
 *   - volumeScale: 音量
 * @returns {Promise<Buffer>} WAV バイナリ（Node.js Buffer）
 */
async function synthesize(text, voiceParams) {
  if (!text || text.trim().length === 0) {
    throw new Error('TTS: text is empty');
  }
  if (!voiceParams || typeof voiceParams.speaker_id !== 'number') {
    throw new Error('TTS: voiceParams.speaker_id is required');
  }

  const speakerId = voiceParams.speaker_id;

  // ステップ1: audio_query で AudioQuery JSON 取得
  // VOICEVOX は POST /audio_query を要求（GET ではなく）
  const queryUrl = `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
  const queryRes = await fetch(queryUrl, { method: 'POST' });

  if (!queryRes.ok) {
    throw new Error(`VOICEVOX audio_query failed: ${queryRes.status} (speaker=${speakerId})`);
  }

  const audioQuery = await queryRes.json();

  // ステップ2: voiceParams で AudioQuery を上書き
  if (typeof voiceParams.speedScale === 'number') {
    audioQuery.speedScale = voiceParams.speedScale;
  }
  if (typeof voiceParams.pitchScale === 'number') {
    audioQuery.pitchScale = voiceParams.pitchScale;
  }
  if (typeof voiceParams.intonationScale === 'number') {
    audioQuery.intonationScale = voiceParams.intonationScale;
  }
  if (typeof voiceParams.volumeScale === 'number') {
    audioQuery.volumeScale = voiceParams.volumeScale;
  }

  // ステップ3: synthesis で WAV 取得
  const synthUrl = `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`;
  const synthRes = await fetch(synthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(audioQuery),
  });

  if (!synthRes.ok) {
    throw new Error(`VOICEVOX synthesis failed: ${synthRes.status} (speaker=${speakerId})`);
  }

  // WAV バイナリを ArrayBuffer → Buffer に変換
  const arrayBuffer = await synthRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * WAV バイナリを Base64 文字列に変換
 * WebSocket のテキストフレームで送るために使う
 *
 * AWS API Gateway WebSocket がバイナリフレーム非対応のため、
 * Base64 でテキストとして送信する設計に統一。
 * ローカル(Node.js + ws) でも同じコードで動く。
 *
 * @param {Buffer} wavBuffer
 * @returns {string} Base64 エンコード済み文字列
 */
function wavToBase64(wavBuffer) {
  return wavBuffer.toString('base64');
}

/**
 * VOICEVOX の生存確認
 * サーバー起動時に呼んで、繋がるかチェックする
 *
 * @returns {Promise<boolean>}
 */
async function checkVoicevoxAvailable() {
  try {
    const res = await fetch(`${VOICEVOX_URL}/version`);
    if (!res.ok) return false;
    const version = await res.text();
    console.log(`\u2713 VOICEVOX connected: ${VOICEVOX_URL} (version ${version})`);
    return true;
  } catch (e) {
    console.warn(`[!] VOICEVOX not available at ${VOICEVOX_URL}: ${e.message}`);
    console.warn('   TTS will be skipped, text-only responses will be sent');
    return false;
  }
}

module.exports = {
  synthesize,
  wavToBase64,
  checkVoicevoxAvailable,
  VOICEVOX_URL,
};