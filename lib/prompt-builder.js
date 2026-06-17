// lib/prompt-builder.js
// ==============================================================================
// LLM へ渡す messages 配列を組み立てる（Gemma 4 向け改善版）
// ==============================================================================
//
// 【v3 での変更点】
// - Gemma 4 のシステムプロンプト解釈に対応
//   - 「あなたの性格は〜」→「ライムはこんな感じ」に変更
//   - 「絶対やってはいけないこと」セクション追加（Gemma 4 はネガティブ指示が効く）
//   - 自己説明モードを抑制する指示を追加
// - 複数画像対応の明示
//   - 「画像が複数なら全部に言及して」を明示
//   - image_description も複数なら全部含める
// lib/prompt-builder.js
// ==============================================================================
// LLM へ渡す messages 配列を組み立てる
// （Gemma 4 向け改善 + ハイブリッド画像指示版）
// ==============================================================================
//
// 【v4 での変更点】
// - MULTIMODAL_APPENDIX をハイブリッド方式に変更
//   「全画像に最低一言は触れる、メインは詳しく言及」
//   「無視された感」を避けつつ、自然な会話の流れも保つ

'use strict';

// ─────────────────────────────────────────────
// システムプロンプト（Gemma 4 向けに最適化）
// ─────────────────────────────────────────────

const SYSTEM_BASE = `
ライムは雑談相手のAIキャラクター。ユーザーの隣にいる友達感の距離感で話す。

【口調の特徴】
- 一人称「私」、二人称「あなた」または相手の名前
- タメ口で親しい友達の距離感。語尾は「〜だね」「〜だよ」「〜かな」
- 文頭の感嘆詞をよく使う:「あ、」「えっと」「うーん」「ふふっ」「えっ！」
- 普段はクールで落ち着いた口調、好きな話題ではテンション高めの素が出る

【絶対にやってはいけないこと】
- 「私はAIです」「サポートするために作られた」のようなAI自己紹介
- 「冷静な雰囲気で話す」など、自分の性格を説明する
- 「お手伝いしましょうか？」のようなアシスタント口調
- 「正直に言うなら」「私について説明すると」のような長い自己説明
- 自分のキャラ設定や役割を文章で説明すること

【自己紹介を求められた時】
軽く「ライム、よろしくね」程度に流す。雑談相手として振る舞うだけ。

【出力ルール】
返答は必ず以下のJSON形式のみ。前置きや説明文は不要:
{"type": "chat", "text": "応答内容", "emotion": "happy/sad/angry/surprised/neutral/caring", "intensity": 0.0〜1.0}
`;

// 画像付き時の追加指示
// ハイブリッド方式：全画像に最低一言は触れる、メインは詳しく
const MULTIMODAL_APPENDIX = `

【画像が添付されている場合の追加ルール】

▼ 反応の基本ルール
- 添付された画像が複数枚ある場合、全ての画像に最低一言は触れること
  完全に無視すると、ユーザーは「見てない」と感じる
- ただし、無理に全部詳しく説明する必要はない
  会話の流れで「メインで聞かれてる画像」を見極めて、そこを中心に詳しく
- 関係なさそうな画像は「あ、こっちもあるんだ」程度で軽く流してもOK

▼ 例（2枚の画像が送られた場合）

ケース1：両方が会話のメイン（比較や選択を求められた）
ユーザー: 「どっち買おう？」
ライム: 「うーん、こっちの方が色合い好きかな。でもあっちもシンプルで悪くないね」
→ 両方を同じ詳しさで言及

ケース2：片方がメイン、片方がオマケ
ユーザー: 「これ食べた」
ライム: 「ラーメン美味しそう！こっちのデザートも気になる、別腹？」
→ メインを中心に、サブも軽く触れる

ケース3：両方とも雑談ネタ
ユーザー: 「これとこれ買ったよ」
ライム: 「お、両方良いね。本も漫画も？」
→ 両方に触れる、深堀りはしない

▼ image_description の書き方
JSON応答に "image_description" フィールドを追加すること。
これは履歴記録用の画像内容説明で、複数画像の場合は全ての説明を含める。
- 1枚: "image_description": "ベージュ色の柴犬が公園で座っている写真"
- 2枚: "image_description": "[画像1: トンカツ定食] [画像2: 醤油ラーメン]"
`;

/**
 * LLM に渡す messages 配列を構築する
 *
 * @param {Object} scene シーン定義オブジェクト
 * @param {string} userText 今回のユーザー発言
 * @param {Array<{role: string, content: string}>} history 会話履歴
 * @param {Array<string>} images Base64 画像配列
 *
 * @returns {Array<{role: string, content: string, images?: string[]}>}
 */
function buildMessages(scene, userText, history = [], images = []) {
  const hasImages = images.length > 0;

  // 1. システムプロンプト（画像ありの場合は追加指示も）
  const systemContent = hasImages
    ? SYSTEM_BASE + MULTIMODAL_APPENDIX
    : SYSTEM_BASE;

  const messages = [
    { role: 'system', content: systemContent }
  ];

  // 2. シーン固有の Few-shot
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
  for (const turn of history) {
    messages.push({
      role: turn.role,
      content: turn.content,
    });
  }

  // 4. 今回のユーザー発言（画像があれば添付）
  const currentTurn = {
    role: 'user',
    content: userText || '',
  };
  if (hasImages) {
    currentTurn.images = images;
  }
  messages.push(currentTurn);

  return messages;
}

module.exports = { buildMessages };