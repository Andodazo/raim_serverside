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
//
// 【v5 での変更点】
// - callLLMWithTools 追加: tools パラメータ付きで stream:false 呼出
// - 既存の callLLM / callLLMStream は維持
//
// 【設計判断】
// Function Calling は stream:false で呼ぶ（Ollama の制約：streaming + tools は不安定）
// その代わり、ツール実行後の最終応答は既存の callLLMStream で行うことで
// ストリーミング応答（A-3）のメリットを保つ。

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// LLM 生成パラメータ（Gemma 4 公式推奨値）
// ─────────────────────────────────────────────
const LLM_OPTIONS = {
  temperature: 1.0,
  top_p: 0.95,
  top_k: 64,
};

// ─────────────────────────────────────────────
// 非ストリーミング呼出
// ─────────────────────────────────────────────

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
    throw new Error('AWS mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// ストリーミング呼出
// ─────────────────────────────────────────────

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
    throw new Error('AWS streaming mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// Function Calling 用呼出（新規）
// ─────────────────────────────────────────────

/**
 * LLM を tools 付きで呼び出す（stream:false 強制）
 *
 * Ollama の制約: streaming + tools は known issues あり
 * → tools 使う時は必ず stream:false
 *
 * @param {Array} messages
 * @param {Array} tools tool 定義配列（OpenAI 形式）
 * @returns {Promise<Object>} {
 *   content: string,             // LLM の応答テキスト（空文字の可能性あり）
 *   thinking: string | null,     // Gemma 4 の思考プロセス（あれば）
 *   tool_calls: Array | null,    // ツール呼出（あれば）
 * }
 *
 * 【Gemma 4 12B の挙動メモ】
 * - tool_calls 返す時、content は空文字になる傾向
 * - thinking フィールドに思考プロセスが入る
 * - tool_calls.function.arguments は object 形式（文字列ではない）
 */
async function callLLMWithTools(messages, tools) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_LLM_MODEL,
        messages,
        tools,
        stream: false,
        options: LLM_OPTIONS,
        // 注: format: 'json' は tools 使用時には付けない
        // Ollama が tool_calls 形式で応答を返すため、追加のJSON強制は不要
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama LLM with tools error: ${res.status}`);
    }

    const data = await res.json();
    const msg = data.message || {};

    return {
      content: msg.content || '',
      thinking: msg.thinking || null,
      tool_calls: msg.tool_calls || null,
    };
  } else {
    // AWS Bedrock の Function Calling 実装は AWS 移行時に書く
    // Gemma 4 31B / 26B-A4B は native function calling 対応
    throw new Error('AWS function calling mode not implemented yet');
  }
}

module.exports = {
  callLLM,
  callLLMStream,
  callLLMWithTools,
  LLM_OPTIONS,
};