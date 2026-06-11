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

'use strict';

const path = require('path');
const { embed, embedMultimodal } = require('./embed');

// ─────────────────────────────────────────────
// 内部状態
// ─────────────────────────────────────────────

let SCENES = null;
let SCENE_BY_ID = null;

// 画像があった時に優先したい「見せる系」シーン
// 食事・ゲーム・トラブル報告など、画像を伴いやすい話題
const VISUAL_SCENES = ['food', 'gaming', 'tech_trouble'];

// 画像があった時に上記シーンのスコアに加算する補正値
// 大きすぎると常に visual シーンが選ばれる、小さすぎると効果がない
// 0.10 は実験的に「テキストだけだと default だが、画像があれば visual を取れる」値
const HAS_IMAGE_BIAS = 0.10;

// シーン判定のしきい値（これ以下なら default にフォールバック）
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
// コサイン類似度（両方とも正規化済み前提）
// ─────────────────────────────────────────────

function cosineSim(a, b) {
  // 両ベクトルとも normalize 済み（embed.js 側で正規化）なのでドット積でOK
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ─────────────────────────────────────────────
// シーン判定
// ─────────────────────────────────────────────

/**
 * ユーザー発言（と画像）からシーンを判定する
 *
 * @param {string} userText ユーザー発言
 * @param {Object} options
 * @param {Array<string>} options.images Base64 画像配列（マルチモーダル対応）
 * @param {number} options.threshold しきい値（デフォルト 0.6）
 *
 * @returns {Promise<{
 *   scene: Object,        // 選ばれたシーン定義
 *   score: number,        // そのシーンとの類似度スコア
 *   method: string,       // 判定方法（'keyword' / 'embedding' / 'fallback'）
 *   needsSearch: boolean, // 検索が必要か（天気・ニュース系）
 *   hasImage: boolean     // 画像が添付されていたか
 * }>}
 */
async function pickScene(userText, options = {}) {
  if (!SCENES) loadEmbeddedScenes();

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const images = options.images || [];
  const hasImage = images.length > 0;

  // ─── 1. キーワード優先判定 ───
  // 天気・ニュース系は即座にシーン確定 + 検索必要フラグ
  if (/(天気|気温|降水)/.test(userText)) {
    return {
      scene: SCENE_BY_ID.default,
      score: 1.0,
      method: 'keyword',
      needsSearch: true,
      hasImage,
    };
  }

  // ─── 2. Embedding 計算 ───
  // ローカル: テキストだけで Embedding（画像はフォールバック）
  // 本番: テキスト+画像で真のマルチモーダル Embedding
  const { vector: userVec } = await embedMultimodal(userText, images);

  // ─── 3. 各シーンの centroid と類似度比較 + hasImage バイアス補正 ───
  let best = { id: 'default', score: -1 };
  const allScores = [];

  for (const scene of SCENES) {
    let score = cosineSim(userVec, scene.centroid);

    // hasImage バイアス補正: 画像があれば visual 系シーンを優遇
    // 本番(Bedrock)では真のマルチモーダル Embedding がスコアに反映されるので、
    // 補正は不要（しなくても自然と visual 系が高スコアになる）
    // ただし bge-m3（ローカル）では補正必須
    const isLocal = !process.env.RAIM_MODE || process.env.RAIM_MODE === 'local';
    if (isLocal && hasImage && VISUAL_SCENES.includes(scene.id)) {
      score += HAS_IMAGE_BIAS;
    }

    allScores.push({ id: scene.id, score: score.toFixed(3) });

    if (score > best.score) best = { id: scene.id, score };
  }

  console.log(`[?] Similarity scores: ${JSON.stringify(allScores)}${hasImage ? ' (hasImage=true)' : ''}`);

  // ─── 4. しきい値判定 ───
  if (best.score < threshold) {
    return {
      scene: SCENE_BY_ID.default,
      score: best.score,
      method: 'fallback',
      needsSearch: false,
      hasImage,
    };
  }

  return {
    scene: SCENE_BY_ID[best.id],
    score: best.score,
    method: 'embedding',
    needsSearch: false,
    hasImage,
  };
}

module.exports = { pickScene, VISUAL_SCENES, HAS_IMAGE_BIAS };