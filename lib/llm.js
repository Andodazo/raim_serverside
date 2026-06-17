// lib/llm.js
// ==============================================================================
// 生成LLM 呼び出しの抽象化レイヤー（Gemma 4 推奨パラメータ対応版）
// ==============================================================================
//
// 【このファイルの役割】
// Ollama / Bedrock 等の生成LLMを呼び出すための統一インターフェース。
// 環境変数 RAIM_MODE で local / aws を切り替える。
//
// 【v4 での変更点】
// - Gemma 4 公式推奨パラメータに変更
//   temperature 0.8 → 1.0
//   top_p 0.9 → 0.95
//   top_k 追加（64）
// - Gemma 4 は JSON 形式遵守能力が大幅向上したため、temperature 高めでも安定する
// - 高 temperature でライムのキャラの個性が出やすくなる

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// LLM 生成パラメータ（Gemma 4 公式推奨値）
//
// temperature 1.0: 応答のランダム性・個性
//   Gemma 3 までは 0.8 が無難だったが、Gemma 4 は 1.0 で最良の出力
//   キャラチャットで個性を出すには 1.0 が向く
//   応答の幅が広がり、感嘆詞や自然な口調が出やすい
//
// top_p 0.95: 候補単語の絞り込み
//   上位 95% の候補から選ぶ（極端な単語を弾く）
//   Gemma 4 では 0.95 が推奨、応答の自然さが向上
//
// top_k 64: 上位 K 個から選ぶ
//   一定の語彙範囲内で多様性を確保
//   Gemma 4 公式推奨
// ─────────────────────────────────────────────
const LLM_OPTIONS = {
  temperature: 1.0,
  top_p: 0.95,
  top_k: 64,
};

// ─────────────────────────────────────────────
// 非ストリーミング呼出（既存、互換用）
// ─────────────────────────────────────────────

/**
 * LLM を呼び出して完全な応答を一括取得する
 * 非ストリーミング応答（RAIM_STREAMING=false の時に使用）
 *
 * @param {Array} messages Ollama messages 配列
 * @returns {Promise<string>} LLM の応答（JSON 形式の文字列）
 */
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
        options: LLM_OPTIONS,
      }),
    });
    if (!res.ok) throw new Error(`Ollama LLM error: ${res.status}`);
    const data = await res.json();
    return data.message.content;
  } else {
    // AWS Bedrock 実装は AWS 移行時に書く
    // 参考実装：
    /*
    const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: 'ap-northeast-1' });
    const res = await client.send(new InvokeModelCommand({
      modelId: 'google.gemma-4-31b',  // または 26b-a4b
      body: JSON.stringify({
        messages,
        max_tokens: 1024,
        temperature: LLM_OPTIONS.temperature,
        top_p: LLM_OPTIONS.top_p,
        top_k: LLM_OPTIONS.top_k,
      }),
      contentType: 'application/json',
    }));
    const data = JSON.parse(new TextDecoder().decode(res.body));
    return data.choices[0].message.content;
    */
    throw new Error('AWS mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// ストリーミング呼出
// ─────────────────────────────────────────────

/**
 * LLM を呼び出して応答をトークン単位でストリーミング取得する
 *
 * Ollama の /api/chat エンドポイントは stream:true 指定で
 * NDJSON 形式のチャンクを順次返してくる。
 *
 * @param {Array} messages Ollama messages 配列
 * @returns {AsyncGenerator<string>} トークン文字列を順次 yield
 */
async function* callLLMStream(messages) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_LLM_MODEL,
        messages,
        stream: true,
        format: 'json',
        options: LLM_OPTIONS,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama LLM stream error: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim().length === 0) continue;

          try {
            const chunk = JSON.parse(line);

            if (chunk.message && chunk.message.content) {
              yield chunk.message.content;
            }

            if (chunk.done) {
              return;
            }
          } catch (e) {
            console.warn('[LLM Stream] Parse warning:', e.message);
          }
        }
      }

      if (buffer.trim().length > 0) {
        try {
          const chunk = JSON.parse(buffer);
          if (chunk.message && chunk.message.content) {
            yield chunk.message.content;
          }
        } catch (e) {
          console.warn('[LLM Stream] Final buffer parse warning:', e.message);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // AWS Bedrock Streaming 実装は AWS 移行時に書く
    throw new Error('AWS streaming mode not implemented yet');
  }
}

module.exports = { callLLM, callLLMStream, LLM_OPTIONS };