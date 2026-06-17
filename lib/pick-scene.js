// lib/pick-scene.js
// ==============================================================================
// シーン判定ロジック（マルチモーダル対応版）
// ==============================================================================
//
// 【このファイルの役割】
// ユーザー発言（と画像）から最適なシーンを選ぶ。
// 選ばれたシーンの Few-shot がプロンプトに差し込まれて、ライムの応答スタイルが変わる。
//
// 【判定の流れ】
// 1. キーワード優先判定（高速、確定的）
//    - 「天気」「ニュース」など特定キーワードは即座にシーン確定（検索フラグも付与）
// 2. Embedding ベースの意味判定
//    - bge-m3 でユーザー発言をベクトル化
//    - 各シーンの centroid とコサイン類似度を計算
//    - 最も近いシーンを選択
// 3. hasImage バイアス補正（マルチモーダル対応の新機能）
//    - 画像が添付されていたら、visual 系シーン（food/gaming/tech_trouble）に +0.10 加算
//    - 「これ食べた」+ピザ画像が default になるのを防ぐ
// 4. しきい値以下なら default にフォールバック
//
// 【設計の思想】
// ローカル(Ollama)では画像 Embedding できないので、バイアス補正で擬似的に画像情報を反映。
// 本番(Bedrock Titan Multimodal)では embedMultimodal が真のマルチモーダル Embedding を返すので、
// バイアス補正なしで自然にシーン判定できる（hasImage フラグだけ見て補正をスキップする設計）。

// ==============================================================================
// シーン判定ロジック（ストリーミング対応版 - default_emotion 返却）
// ==============================================================================
//
// 【v3 での変更点】
// - 返り値に scene.default_emotion / scene.default_intensity を含める
// - ストリーミング応答の metadata 即送信に使う
// - シーン定義ファイル (scenes/*.json) に default_emotion / default_intensity フィールドを追加すること
//
// 【default_emotion / default_intensity のルール】
// - シーン定義から取得（scenes/*.json で指定）
// - 未指定なら neutral / 0.5 にフォールバック
// - LLM 応答完了時に、実際の emotion で上書きされる可能性あり（多くの場合は同じ）

'use strict';

const path = require('path');
const { embed, embedMultimodal } = require('./embed');

// ─────────────────────────────────────────────
// 内部状態
// ─────────────────────────────────────────────

let SCENES = null;
let SCENE_BY_ID = null;

const VISUAL_SCENES = ['food', 'gaming', 'tech_trouble'];
const HAS_IMAGE_BIAS = 0.10;
const DEFAULT_THRESHOLD = 0.6;

// ─────────────────────────────────────────────
// シーンデータのロード
// ─────────────────────────────────────────────

function loadEmbeddedScenes() {
  const data = require(path.join(__dirname, '..', 'scenes-embedded.json'));
  SCENES = data.scenes;
  SCENE_BY_ID = Object.fromEntries(SCENES.map(s => [s.id, s]));
  console.log(`\u2713 Loaded ${SCENES.length} embedded scenes (model=${data.model}, dim=${data.dim})`);
}

// ─────────────────────────────────────────────
// コサイン類似度
// ─────────────────────────────────────────────

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ─────────────────────────────────────────────
// デフォルト emotion / intensity の取得
// ─────────────────────────────────────────────

/**
 * シーン定義から default_emotion / default_intensity を取り出す
 * 未指定の場合は neutral / 0.5 にフォールバック
 */
function getDefaultMetadata(scene) {
  return {
    default_emotion: scene.default_emotion || 'neutral',
    default_intensity: typeof scene.default_intensity === 'number'
      ? scene.default_intensity
      : 0.5,
  };
}

// ─────────────────────────────────────────────
// シーン判定
// ─────────────────────────────────────────────

/**
 * ユーザー発言（と画像）からシーンを判定する
 *
 * @param {string} userText
 * @param {Object} options
 * @param {Array<string>} options.images Base64 画像配列
 * @param {number} options.threshold しきい値
 *
 * @returns {Promise<{
 *   scene: Object,
 *   score: number,
 *   method: string,
 *   needsSearch: boolean,
 *   hasImage: boolean,
 *   defaultEmotion: string,       // 新規: シーンのデフォルト感情
 *   defaultIntensity: number,     // 新規: シーンのデフォルト強度
 * }>}
 */
async function pickScene(userText, options = {}) {
  if (!SCENES) loadEmbeddedScenes();

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const images = options.images || [];
  const hasImage = images.length > 0;

  // 1. キーワード優先判定
  if (/(天気|気温|降水)/.test(userText)) {
    const scene = SCENE_BY_ID.default;
    const meta = getDefaultMetadata(scene);
    return {
      scene,
      score: 1.0,
      method: 'keyword',
      needsSearch: true,
      hasImage,
      defaultEmotion: meta.default_emotion,
      defaultIntensity: meta.default_intensity,
    };
  }

  // 2. Embedding 計算
  const { vector: userVec } = await embedMultimodal(userText, images);

  // 3. 各シーンの centroid と類似度比較 + hasImage バイアス補正
  let best = { id: 'default', score: -1 };
  const allScores = [];

  for (const scene of SCENES) {
    let score = cosineSim(userVec, scene.centroid);

    const isLocal = !process.env.RAIM_MODE || process.env.RAIM_MODE === 'local';
    if (isLocal && hasImage && VISUAL_SCENES.includes(scene.id)) {
      score += HAS_IMAGE_BIAS;
    }

    allScores.push({ id: scene.id, score: score.toFixed(3) });
    if (score > best.score) best = { id: scene.id, score };
  }

  console.log(`[?] Similarity scores: ${JSON.stringify(allScores)}${hasImage ? ' (hasImage=true)' : ''}`);

  // 4. しきい値判定
  let selectedScene;
  let method;

  if (best.score < threshold) {
    selectedScene = SCENE_BY_ID.default;
    method = 'fallback';
  } else {
    selectedScene = SCENE_BY_ID[best.id];
    method = 'embedding';
  }

  const meta = getDefaultMetadata(selectedScene);

  return {
    scene: selectedScene,
    score: best.score,
    method,
    needsSearch: false,
    hasImage,
    defaultEmotion: meta.default_emotion,
    defaultIntensity: meta.default_intensity,
  };
}

module.exports = { pickScene, VISUAL_SCENES, HAS_IMAGE_BIAS };