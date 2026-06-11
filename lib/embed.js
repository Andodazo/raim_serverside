// lib/embed.js
// ==============================================================================
// Embedding 計算の抽象化レイヤー（マルチモーダル対応版）
// ==============================================================================
//
// 【このファイルの役割】
// テキスト（と将来は画像）をベクトル化して、シーン判定や類似検索に使えるようにする。
// 環境変数 RAIM_MODE で切り替え:
//   local → Ollama の bge-m3 で計算
//   aws   → Bedrock Titan Embeddings v2 / Titan Multimodal Embeddings G1 で計算
//
// 【マルチモーダル対応の現状】
//
// ローカル(Ollama):
//   - bge-m3 はテキスト専用、画像 Embedding は未対応（Ollama 公式 issue #5304）
//   - 画像があった場合は「テキストだけで Embedding + hasImage フラグ返却」というフォールバック
//   - シーン判定側で hasImage を見てバイアス補正する設計
//
// 本番(AWS Bedrock):
//   - Titan Multimodal Embeddings G1（amazon.titan-embed-image-v1）でテキスト+画像を同空間に Embedding
//   - $0.00006/画像、1024 次元
//   - ライム運用想定では月数円〜十数円程度のコスト
//   - スキーマ移行時は本ファイルの中身だけ書き換えればよい設計
//
// 【参考】
// docs/multimodal-spec.md の 7.1「シーン判定への影響」

'use strict';

const MODE = process.env.RAIM_MODE || 'local';

// ─────────────────────────────────────────────
// ベクトル正規化
// ─────────────────────────────────────────────

/**
 * ベクトルを L2 ノルムで正規化（単位ベクトル化）
 * これによりコサイン類似度が単純なドット積で計算できる
 */
function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec; // ゼロベクトル防御
  return vec.map(v => v / norm);
}

// ─────────────────────────────────────────────
// テキスト Embedding（既存）
// ─────────────────────────────────────────────

/**
 * テキストを 1024 次元ベクトルに変換
 *
 * @param {string} text
 * @returns {Promise<number[]>} 正規化済み 1024 次元ベクトル
 */
async function embed(text) {
  if (MODE === 'local') {
    // Ollama の Embeddings API を叩く
    const res = await fetch(`${process.env.OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_EMBED_MODEL, // bge-m3
        prompt: text
      })
    });
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
    const data = await res.json();
    return normalize(data.embedding);
  } else {
    // 本番 Bedrock Titan Text Embeddings v2 実装は AWS 移行時に書く
    // 参考実装:
    /*
    const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: 'ap-northeast-1' });
    const res = await client.send(new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      body: JSON.stringify({ inputText: text, dimensions: 1024, normalize: true }),
      contentType: 'application/json',
    }));
    const data = JSON.parse(new TextDecoder().decode(res.body));
    return data.embedding; // 既に正規化済み
    */
    throw new Error('AWS embed mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// マルチモーダル Embedding（新規）
// ─────────────────────────────────────────────

/**
 * テキストと画像（複数可）を統合した Embedding を計算
 *
 * ローカル(Ollama):
 *   - bge-m3 は画像非対応なので、テキストだけで Embedding して hasImage フラグを返す
 *   - シーン判定側で hasImage を見てバイアス補正
 *
 * 本番(Bedrock):
 *   - Titan Multimodal Embeddings G1 で画像とテキストを同空間に Embedding
 *   - 画像も含めた精密なシーン判定が可能
 *
 * @param {string} text ユーザー発言テキスト
 * @param {Array<string>} images Base64 画像配列（0 枚なら通常の embed と同じ動作）
 * @returns {Promise<{vector: number[], hasImage: boolean}>}
 *   vector: 1024 次元ベクトル（正規化済み）
 *   hasImage: 画像が入力に含まれていたか（シーン判定のバイアス補正用）
 */
async function embedMultimodal(text, images = []) {
  const hasImage = images.length > 0;

  if (MODE === 'local') {
    // ローカル: テキストだけで Embedding（画像はフォールバック）
    // テキストが空でも何か投げないと Embedding 計算できないので、最低限のテキストを使う
    const effectiveText = (text && text.length > 0) ? text : '画像が送られた';
    const vector = await embed(effectiveText);
    return { vector, hasImage };
  } else {
    // 本番 Bedrock Titan Multimodal Embeddings 実装は AWS 移行時に書く
    // Titan Multimodal Embeddings G1 のAPI仕様:
    //   inputText と inputImage（Base64）の片方 or 両方を指定可能
    //   現状の Titan は 1 回のリクエストで 1 画像のみ
    //   複数画像は枚数分リクエストして平均ベクトルを取るなどの工夫が必要
    /*
    const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: 'ap-northeast-1' });

    // 1 画像の場合: テキストと画像を 1 リクエストで送る
    if (images.length === 1) {
      const res = await client.send(new InvokeModelCommand({
        modelId: 'amazon.titan-embed-image-v1',
        body: JSON.stringify({
          inputText: text || undefined,
          inputImage: images[0],
          embeddingConfig: { outputEmbeddingLength: 1024 }
        }),
        contentType: 'application/json',
      }));
      const data = JSON.parse(new TextDecoder().decode(res.body));
      return { vector: data.embedding, hasImage: true };
    }

    // 複数画像の場合: 各画像 + テキストで Embedding して平均
    const vectors = await Promise.all(images.map(async (img) => {
      const res = await client.send(new InvokeModelCommand({
        modelId: 'amazon.titan-embed-image-v1',
        body: JSON.stringify({
          inputText: text || undefined,
          inputImage: img,
          embeddingConfig: { outputEmbeddingLength: 1024 }
        }),
        contentType: 'application/json',
      }));
      const data = JSON.parse(new TextDecoder().decode(res.body));
      return data.embedding;
    }));

    // 平均ベクトル
    const dim = vectors[0].length;
    const avg = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) avg[i] += v[i] / vectors.length;
    }
    return { vector: normalize(avg), hasImage: true };
    */
    throw new Error('AWS multimodal embed mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  embed,             // テキストのみ（既存互換）
  embedMultimodal,   // マルチモーダル対応（新規）
  normalize,
};