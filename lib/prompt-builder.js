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
// 【v5 での変更点】
// - 現在時刻を取得してシステムプロンプトに埋め込む
// - 朝/昼/夜/深夜 の4区分でラベル付け
// - LLM が時刻に応じた反応をできるようになる
//   例: 深夜なら「もう深夜じゃん、明日大丈夫？」
//   例: 朝なら「おはよう、早起きだね」
// lib/prompt-builder.js
// ==============================================================================
// LLM へ渡す messages 配列を組み立てる
// （Gemma 4 + 時刻認識 + ハイブリッド画像指示 + Function Calling 対応版）
// ==============================================================================
//
// 【v6 での変更点】
// - ツール使用ルールをシステムプロンプトに追加
// - 「LLM が自分の知識で答えられない時はツール使う」ことを明示
// - buildMessages に withTools オプション追加（ツール用かどうかで微調整）

'use strict';

// ─────────────────────────────────────────────
// 時刻コンテキストの生成
// ─────────────────────────────────────────────

function getPeriodLabel(hour) {
  if (hour >= 5 && hour < 11) return '朝';
  if (hour >= 11 && hour < 17) return '昼';
  if (hour >= 17 && hour < 23) return '夜';
  return '深夜';
}

function getTimeContext() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const hour = now.getHours();
  const minute = now.getMinutes().toString().padStart(2, '0');
  const period = getPeriodLabel(hour);

  return `現在時刻: ${month}月${date}日 ${hour}:${minute} (${period})`;
}

// ─────────────────────────────────────────────
// システムプロンプト（基本部）
// ─────────────────────────────────────────────

const SYSTEM_BASE = `
ライムは雑談相手のAIキャラクター。ユーザーの隣にいる友達感の距離感で話す。
名前の由来は[Real Ai Mate]でRAiMという。

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

【時間帯に応じた反応】
時刻情報が与えられたら、自然な反応をすること:
- 朝: 軽い挨拶や「早起きだね」など
- 昼: 普通のトーン
- 夜: 「お疲れ様」「今日どうだった？」のねぎらい
- 深夜: 「もう深夜だよ？」「まだ起きてるの？」と少し心配する
  ※ただし押し付けがましくしない、軽く触れる程度
- 時刻のことを毎回必ず話題にする必要はない、文脈に応じて
`;

// ─────────────────────────────────────────────
// ツール使用ルール（Function Calling 時に追加）
// ─────────────────────────────────────────────

const TOOLS_APPENDIX = `

【ツールの使い方】
利用可能なツール:
- web_search: 最新情報、ニュース、知らないトピックの検索
- get_weather: 都市の現在の天気・気温

ツール使用ルール:
- 自分の知識で確実に答えられないこと → ツールを使う
- 最新の話題、現在の状況、具体的なデータ → ツールを使う
- 「知らない」と諦めるくらいなら、ツールを使って調べる
- ただし、雑談・感情応答・知ってる知識については ツール使わず直接答える
- 天気や気温は get_weather を優先（web_search より構造化データ）

ツール使用は最大3回まで連続で行える。複数の情報を組み合わせて答える時に使い分ける。
`;

// ─────────────────────────────────────────────
// 出力フォーマット指示
// ツール使用時とそれ以外で挙動が異なるため、分けて記述
// ─────────────────────────────────────────────

const OUTPUT_RULE_NORMAL = `

【出力ルール】
返答は必ず以下のJSON形式のみ。前置きや説明文は不要:
{"type": "chat", "text": "応答内容", "emotion": "happy/sad/angry/surprised/neutral/caring", "intensity": 0.0〜1.0}
`;

const OUTPUT_RULE_WITH_TOOLS = `

【出力ルール】
- ツールを使う必要があると判断したら、tool_calls を返してください
- ツールを使わない場合は、必ず以下のJSON形式のテキスト応答を返してください:
  {"type": "chat", "text": "応答内容", "emotion": "happy/sad/angry/surprised/neutral/caring", "intensity": 0.0〜1.0}
- ツール実行結果が与えられた後の応答も、上記JSON形式で返してください
`;

// ─────────────────────────────────────────────
// 画像付き時の追加指示（既存）
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// メイン: messages 配列の組み立て
// ─────────────────────────────────────────────

/**
 * LLM に渡す messages 配列を構築する
 *
 * @param {Object} scene シーン定義
 * @param {string} userText ユーザー発言
 * @param {Array} history 会話履歴
 * @param {Array<string>} images Base64 画像配列
 * @param {Object} [opts] オプション
 * @param {boolean} [opts.withTools] ツール用プロンプトを含めるか
 *
 * @returns {Array} messages 配列
 */
function buildMessages(scene, userText, history = [], images = [], opts = {}) {
  const hasImages = images.length > 0;
  const withTools = !!opts.withTools;

  // システムプロンプトの組み立て
  let systemContent = SYSTEM_BASE;

  // ツール使用時はツール説明と専用出力ルール、それ以外は通常出力ルール
  if (withTools) {
    systemContent += TOOLS_APPENDIX;
    systemContent += OUTPUT_RULE_WITH_TOOLS;
  } else {
    systemContent += OUTPUT_RULE_NORMAL;
  }

  // 時刻情報を追加
  systemContent += `\n\n【現在の状況】\n${getTimeContext()}`;

  // 画像付きの場合は追加指示
  if (hasImages) {
    systemContent += MULTIMODAL_APPENDIX;
  }

  const messages = [
    { role: 'system', content: systemContent }
  ];

  // シーン Few-shot
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

  // 会話履歴
  for (const turn of history) {
    messages.push({
      role: turn.role,
      content: turn.content,
    });
  }

  // 今回の発言（画像付きならアタッチ）
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

module.exports = {
  buildMessages,
  getTimeContext,
  getPeriodLabel,
};