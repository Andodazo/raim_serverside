// lib/llm.js
// 生成LLM 呼び出しの抽象化レイヤー
//
// 変更点:
// - temperature / top_p を明示的に指定（Ollama / Bedrock のデフォルト依存をやめる）
// - 旧 Flutter プロトタイプ (raim_prototype) で使っていた 0.8 / 0.9 を踏襲
// - 将来パラメータを変えたくなったら、ここの定数だけ書き換えればよい

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// LLM 生成パラメータ（ローカル/本番共通）
//
// temperature: 応答のランダム性・個性
//   0.3 → 安定するが面白みが少ない、JSONフォーマット崩れにくい
//   0.8 → 自然で個性的、キャラチャット標準（推奨）
//   1.1 → 予測不能で生き生き、JSON崩れリスク注意
//
// top_p: 候補単語の絞り込み
//   0.9 → 上位90%の候補から選ぶ（極端な単語を弾く、JSON安定）
//   0.95 → やや多様性を許す
// ─────────────────────────────────────────────
const LLM_OPTIONS = {
  temperature: 0.8,
  top_p: 0.9,
};

async function callLLM(messages) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_LLM_MODEL,
        messages,
        stream: false,
        format: 'json',
        options: LLM_OPTIONS,  // ← Ollama では options に入れる
      }),
    });
    if (!res.ok) throw new Error(`Ollama LLM error: ${res.status}`);
    const data = await res.json();
    return data.message.content;
  } else {
    // 本番（AWS Bedrock）実装は AWS 移行時に書く
    // Bedrock の Gemma 3 でも temperature / top_p は同じ値で投入する
    // ↓ 参考実装（実装時にコメントアウト解除）
    /*
    const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: 'ap-northeast-1' });
    const res = await client.send(new InvokeModelCommand({
      modelId: 'google.gemma-3-12b-it',
      body: JSON.stringify({
        messages,
        max_tokens: 512,
        temperature: LLM_OPTIONS.temperature,  // ← 同じ値を使う
        top_p: LLM_OPTIONS.top_p,
      }),
      contentType: 'application/json',
    }));
    const data = JSON.parse(new TextDecoder().decode(res.body));
    return data.choices[0].message.content;
    */
    throw new Error('AWS mode not implemented yet');
  }
}

module.exports = { callLLM, LLM_OPTIONS };