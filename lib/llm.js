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

'use strict';

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// LLM 生成パラメータ
// ─────────────────────────────────────────────
//
// temperature: 応答のランダム性・個性
//   0.8 → 自然で個性的、キャラチャット標準（推奨）
// top_p: 候補単語の絞り込み
//   0.9 → 上位90%の候補から選ぶ（極端な単語を弾く、JSON安定）
const LLM_OPTIONS = {
  temperature: 0.8,
  top_p: 0.9,
};

/**
 * LLM 呼び出し
 *
 * messages 配列の各要素:
 *   { role: 'system'|'user'|'assistant', content: string, images?: string[] }
 *   images は Base64 文字列の配列（Ollama 仕様）
 *
 * @param {Array<{role: string, content: string, images?: string[]}>} messages
 * @returns {Promise<string>} LLM 応答テキスト（JSON 文字列）
 */
async function callLLM(messages) {
  if (MODE === 'local') {
    return callOllama(messages);
  } else {
    return callBedrock(messages);
  }
}

// ─────────────────────────────────────────────
// Ollama 呼び出し（ローカル）
// ─────────────────────────────────────────────

async function callOllama(messages) {
  // Ollama 仕様に合わせて messages を整形
  // - content: string（テキスト）
  // - images: string[]（Base64 配列、user role のメッセージにのみ付与）
  const ollamaMessages = messages.map(msg => {
    const m = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.images && msg.images.length > 0) {
      // Ollama は data URI プレフィックスなしの純粋な Base64 を期待する
      m.images = msg.images;
    }
    return m;
  });

  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_LLM_MODEL,
      messages: ollamaMessages,
      stream: false,
      format: 'json',
      options: LLM_OPTIONS,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Ollama LLM error: ${res.status} ${errBody}`);
  }

  const data = await res.json();
  return data.message.content;
}

// ─────────────────────────────────────────────
// Bedrock 呼び出し（本番）
// ─────────────────────────────────────────────
//
// 将来の AWS 本番化フェーズで実装する。
// Bedrock の Gemma 3 では content を構造化配列にする形式:
//   {role: 'user', content: [
//     {type: 'text', text: '...'},
//     {type: 'image', source: {type: 'base64', media_type: '...', data: '...'}}
//   ]}

async function callBedrock(messages) {
  // 参考実装（実装時にコメントアウト解除）
  /*
  const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });

  // messages を Bedrock 仕様に変換
  // images があれば content を構造化配列にする
  const bedrockMessages = messages.map(msg => {
    if (!msg.images || msg.images.length === 0) {
      return { role: msg.role, content: msg.content };
    }
    // 画像つきメッセージ
    const contentArray = [{ type: 'text', text: msg.content }];
    for (const img of msg.images) {
      contentArray.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',  // 本来は media_type も messages に持たせる
          data: img,
        },
      });
    }
    return { role: msg.role, content: contentArray };
  });

  const res = await client.send(new InvokeModelCommand({
    modelId: 'google.gemma-3-12b-it',
    body: JSON.stringify({
      messages: bedrockMessages,
      max_tokens: 1024,
      temperature: LLM_OPTIONS.temperature,
      top_p: LLM_OPTIONS.top_p,
    }),
    contentType: 'application/json',
  }));
  const data = JSON.parse(new TextDecoder().decode(res.body));
  return data.choices[0].message.content;
  */
  throw new Error('AWS mode not implemented yet');
}

module.exports = { callLLM, LLM_OPTIONS };