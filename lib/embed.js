// lib/embed.js
const MODE = process.env.RAIM_MODE || 'local';

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

async function embed(text) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_EMBED_MODEL,
        prompt: text
      })
    });
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
    const data = await res.json();
    return normalize(data.embedding);
  } else {
    throw new Error('AWS embed mode not implemented yet');
  }
}

module.exports = { embed, normalize };