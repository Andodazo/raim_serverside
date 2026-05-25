// scripts/build-embeddings.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { embed } = require('../lib/embed');

function averageVectors(vectors) {
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) avg[i] += v[i] / vectors.length;
  }
  return avg;
}

(async () => {
  const sceneDir = path.join(__dirname, '..', 'scenes');
  const files = fs.readdirSync(sceneDir).filter(f => f.endsWith('.json'));
  const scenes = [];

  for (const file of files) {
    const scene = JSON.parse(fs.readFileSync(path.join(sceneDir, file), 'utf-8'));
    process.stdout.write(`Embedding ${scene.id}... `);
    const vectors = await Promise.all(scene.examples.map(embed));
    scene.centroid = averageVectors(vectors);
    scenes.push(scene);
    console.log(`✓ (${vectors.length} examples, ${scene.centroid.length} dims)`);
  }

  const output = {
    model: process.env.OLLAMA_EMBED_MODEL,
    dim: scenes[0].centroid.length,
    builtAt: new Date().toISOString(),
    scenes
  };

  const outPath = path.join(__dirname, '..', 'scenes-embedded.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${outPath}`);
})();