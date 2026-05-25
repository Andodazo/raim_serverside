// lib/llm.js
const MODE = process.env.RAIM_MODE || 'local';

async function callLLM(messages) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_LLM_MODEL,
        messages,
        stream: false,
        format: 'json'
      })
    });
    if (!res.ok) throw new Error(`Ollama LLM error: ${res.status}`);
    const data = await res.json();
    return data.message.content;
  } else {
    // 本番（AWS Bedrock）実装は AWS 移行時に書く
    throw new Error('AWS mode not implemented yet');
  }
}

module.exports = { callLLM };