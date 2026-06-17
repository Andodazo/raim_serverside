// lib/llm.js
// ==============================================================================
// 生成LLM 呼び出しの抽象化レイヤー
// ==============================================================================
//
// 【このファイルの役割】
// ローカル(Ollama) と 本番(AWS Bedrock) で同じインターフェースで LLM を呼べるよう
// 抽象化する。環境変数 RAIM_MODE で切り替わる。
//
// 【v3 での変更点（マルチモーダル対応）】
// - messages の各要素で images フィールド（Base64 配列）を受け取れるように
// - Ollama の chat API では role:user の content と並列に images 配列を渡す形式
// - 本番 Bedrock では将来 content を構造化配列にする形式に変換予定
// ==============================================================================
// 生成LLM 呼び出しの抽象化レイヤー（ストリーミング対応版）
// ==============================================================================
//
// 【このファイルの役割】
// Ollama / Bedrock 等の生成LLMを呼び出すための統一インターフェース。
// 環境変数 RAIM_MODE で local / aws を切り替える。
//
// 【v3 での変更点】
// - callLLMStream() を新規追加（Ollama の stream:true でトークンを順次受信）
// - 既存の callLLM() は非ストリーミング応答用に保持
// - LLM パラメータ（temperature/top_p）の明示は維持

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// LLM 生成パラメータ（ローカル/本番共通）
//
// temperature: 応答のランダム性・個性
//   0.8 → 自然で個性的、キャラチャット標準（推奨）
// top_p: 候補単語の絞り込み
//   0.9 → 上位90%の候補から選ぶ（JSON安定）
// ─────────────────────────────────────────────
const LLM_OPTIONS = {
  temperature: 0.8,
  top_p: 0.9,
};

// ─────────────────────────────────────────────
// 非ストリーミング呼出（既存、互換用）
// ─────────────────────────────────────────────

/**
 * LLM を呼び出して完全な応答を一括取得する
 * 非ストリーミング応答（フェーズA-3 以前の挙動）
 *
 * @param {Array} messages Ollama messages 配列
 * @param {Array<string>} [images] Base64 画像配列（多くの場合は messages 内で指定済み）
 * @returns {Promise<string>} LLM の応答（JSON 形式の文字列）
 */
async function callLLM(messages, images = []) {
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
    throw new Error('AWS mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// ストリーミング呼出（新規）
// ─────────────────────────────────────────────

/**
 * LLM を呼び出して応答をトークン単位でストリーミング取得する
 *
 * Ollama の /api/chat エンドポイントは stream:true 指定で
 * NDJSON 形式のチャンクを順次返してくる。
 * 各チャンクは以下のような構造:
 *   {"message":{"role":"assistant","content":"お"}, "done":false}
 *   {"message":{"role":"assistant","content":"疲"}, "done":false}
 *   ...
 *   {"done":true, ...}
 *
 * このメソッドは async generator として実装し、
 * 呼び出し側で for-await-of でトークンを順次取り出せるようにする。
 *
 * @param {Array} messages Ollama messages 配列
 * @returns {AsyncGenerator<string>} トークン文字列を順次 yield
 *
 * 使い方:
 *   for await (const token of callLLMStream(messages)) {
 *     console.log(token);  // 'お', '疲', 'れ', ...
 *   }
 */
async function* callLLMStream(messages) {
  if (MODE === 'local') {
    const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_LLM_MODEL,
        messages,
        stream: true,         // ← ストリーミング有効
        format: 'json',       // JSON 形式強制
        options: LLM_OPTIONS,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama LLM stream error: ${res.status}`);
    }

    // Ollama は NDJSON（1行1JSON）でレスポンスを返す
    // ReadableStream から1行ずつ取り出してパースする
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // バッファに追加
        buffer += decoder.decode(value, { stream: true });

        // 改行で区切られた行を順次処理
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // 最後の不完全な行はバッファに残す

        for (const line of lines) {
          if (line.trim().length === 0) continue;

          try {
            const chunk = JSON.parse(line);

            // message.content にトークンが入ってる
            if (chunk.message && chunk.message.content) {
              yield chunk.message.content;
            }

            // done フラグが true なら終了
            if (chunk.done) {
              return;
            }
          } catch (e) {
            // パースエラーは無視（不完全な JSON の可能性）
            console.warn('[LLM Stream] Parse warning:', e.message);
          }
        }
      }

      // バッファに残った最後の行を処理
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
    // 参考: InvokeModelWithResponseStreamCommand を使う
    /*
    const { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: 'ap-northeast-1' });
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: 'google.gemma-3-12b-it',
      body: JSON.stringify({
        messages,
        max_tokens: 1024,
        temperature: LLM_OPTIONS.temperature,
        top_p: LLM_OPTIONS.top_p,
      }),
      contentType: 'application/json',
    });
    const response = await client.send(command);
    for await (const event of response.body) {
      if (event.chunk?.bytes) {
        const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        if (chunk.delta?.text) yield chunk.delta.text;
      }
    }
    */
    throw new Error('AWS streaming mode not implemented yet');
  }
}

module.exports = { callLLM, callLLMStream, LLM_OPTIONS };