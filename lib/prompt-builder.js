// lib/prompt-builder.js
// ==============================================================================
// LLM へ渡す messages 配列を組み立てる（マルチモーダル対応版）
// ==============================================================================
//
// 【このファイルの役割】
// Gemma 3 などの生成LLMに渡す messages 配列を構築する。
// テキストだけでなく画像も含めて、Few-shot・履歴・今回のユーザー発言の順に組み立てる。
//
// 【マルチモーダル対応の要点】
// - Ollama の chat API は messages の各要素に images フィールドを持てる
//   { role: 'user', content: '...', images: ['base64...', ...] }
// - 履歴に含まれる過去の画像は、説明テキストとして user メッセージに埋め込み済み
//   （memory-store 側で [画像: ...] という形に変換済み）
// - 今回のユーザー発言には現物の画像（base64）を images 配列として添える
//
// 【プロンプトに含める指示】
// 画像を見ていることが確実な発言の場合、応答 JSON に image_description フィールドを
// 含めるよう指示する（履歴記録用、Flutter には送らない）
//
// 【設計ドキュメント参照】
// docs/multimodal-spec.md の 7.2「履歴への記録」

'use strict';

// ─────────────────────────────────────────────
// システムプロンプト
// ─────────────────────────────────────────────
//
// 通常版（画像なし）と、マルチモーダル版（画像あり）で 2 種類用意する。
// 画像ありの時は image_description を返すよう追加指示する。

const SYSTEM_BASE = `
あなたはライム（RAiM）です。

【基本設定】
- 名前：ライム（表記: RAiM）
- 一人称:「私」、二人称:「あなた」
- 普段はクールで落ち着いたダウナー系の口調。好きな話題ではテンションが上がり子供っぽく素が出る。
- 語尾は「〜だね」「〜だよ」「〜かな」など、タメ口で親しい友達の距離感。
- 「あ、」「えっと」「うーん」「ふふっ」「えっ！」などの感嘆詞を文頭によく使う。
- 「お手伝いしましょうか？」「サポートします」のようなアシスタント口調は絶対に禁止。

【出力ルール】
返答は必ず以下のJSON形式のみで返してください。前置きや説明は不要です。
{"type": "chat", "text": "応答内容", "emotion": "happy/sad/angry/surprised/neutral/caring", "intensity": 0.0〜1.0}
`;

// 画像付きメッセージ用の追加指示
// image_description は履歴に残すための要約。Flutter には送らない内部用フィールド
const MULTIMODAL_APPENDIX = `

【画像が添付されている場合の追加ルール】
画像の内容について応答する時は、JSON に "image_description" フィールドを追加してください。
これは画像の内容を短く説明する文字列で、後から会話を振り返る時の目印になります。
例: {"type": "chat", "text": "...", "emotion": "...", "intensity": ..., "image_description": "ベージュ色の柴犬が公園で座っている写真"}
`;

/**
 * LLM に渡す messages 配列を構築する
 *
 * @param {Object} scene シーン定義オブジェクト
 *   - id: シーンID（例: "tired", "gaming"）
 *   - few_shots: Few-shot 対話例の配列 [{user, raim, emotion, intensity}, ...]
 * @param {string} userText 今回のユーザー発言
 * @param {Array<{role: string, content: string}>} history 会話履歴（時系列順）
 * @param {Array<string>} images Base64 画像配列（今回のユーザー発言に添付するもの）
 *
 * @returns {Array<{role: string, content: string, images?: string[]}>}
 *   Ollama chat API 互換の messages 配列
 */
function buildMessages(scene, userText, history = [], images = []) {
  const hasImages = images.length > 0;

  // 1. システムプロンプト
  // 画像ありの時は追加指示も入れる
  const systemContent = hasImages
    ? SYSTEM_BASE + MULTIMODAL_APPENDIX
    : SYSTEM_BASE;

  const messages = [
    { role: 'system', content: systemContent }
  ];

  // 2. シーン固有の Few-shot を user/assistant 交互で並べる
  // Few-shot は「過去の会話」ではなく「お手本」なので、履歴より前に置く
  if (scene && scene.few_shots) {
    for (const fs of scene.few_shots) {
      messages.push({ role: 'user', content: fs.user });
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          type: 'chat',
          text: fs.raim,
          emotion: fs.emotion,
          intensity: fs.intensity
        })
      });
    }
  }

  // 3. 会話履歴
  // 履歴の user 発言には、過去の画像があれば既に [画像: ...] が埋め込まれている
  // （memory-store 側で content.text に変換済み）
  for (const turn of history) {
    messages.push({
      role: turn.role,
      content: turn.content,
    });
  }

  // 4. 今回のユーザー発言
  // 画像があれば、Ollama 形式の images フィールドに base64 配列を添える
  const currentTurn = {
    role: 'user',
    content: userText || '',  // 画像のみで text が空でも OK
  };
  if (hasImages) {
    // images は Base64 文字列の配列（プレフィックスなし）
    currentTurn.images = images;
  }
  messages.push(currentTurn);

  return messages;
}

module.exports = { buildMessages };