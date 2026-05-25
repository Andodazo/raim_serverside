// lib/pick-scene.js
const path = require('path');
const { embed } = require('./embed');

let SCENES = null;
let SCENE_BY_ID = null;

function loadEmbeddedScenes() {
  const data = require(path.join(__dirname, '..', 'scenes-embedded.json'));
  SCENES = data.scenes;
  SCENE_BY_ID = Object.fromEntries(SCENES.map(s => [s.id, s]));
  console.log(`✓ Loaded ${SCENES.length} embedded scenes (model=${data.model}, dim=${data.dim})`);
}

function cosineSim(a, b) {
  // 両方とも正規化済み（embed側でnormalize済）なのでドット積でOK
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function pickScene(userText, options = {}) {
  if (!SCENES) loadEmbeddedScenes();
  const threshold = options.threshold ?? 0.6;

  // キーワード優先判定（即時、検索フラグも返せる）
  if (/(天気|気温|降水)/.test(userText)) {
    return { scene: SCENE_BY_ID.default, score: 1.0, method: 'keyword', needsSearch: true };
  }

  // Embedding 類似度判定
  const userVec = await embed(userText);
  let best = { id: 'default', score: -1 };
  const all = [];
  for (const scene of SCENES) {
    const score = cosineSim(userVec, scene.centroid);
    all.push({ id: scene.id, score: score.toFixed(3) });
    if (score > best.score) best = { id: scene.id, score };
  }

  console.log(`[?] Similarity scores: ${JSON.stringify(all)}`);

  if (best.score < threshold) {
    return { scene: SCENE_BY_ID.default, score: best.score, method: 'fallback', needsSearch: false };
  }
  return { scene: SCENE_BY_ID[best.id], score: best.score, method: 'embedding', needsSearch: false };
}

module.exports = { pickScene };