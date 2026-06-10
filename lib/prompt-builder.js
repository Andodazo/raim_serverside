// lib/prompt-builder.js
// ==============================================================================
// LLM へ渡す messages 配列を組み立てる
// ==============================================================================
//
// 【このファイルの役割】
// Gemma 3 などの生成LLMに渡す messages 配列を構築する。
// システムプロンプト、Few-shot 対話例、会話履歴、今回のユーザー発言の順番に並べる。
//
// 【messages配列の構造】
// LLM は以下のような形式で会話履歴を受け取る:
//   [
//     {role: 'system',    content: 'あなたはライムです...'},     ← 性格定義
//     {role: 'user',      content: '疲れた'},                    ← Few-shot 例
//     {role: 'assistant', content: '{"text":"お疲れ様"...}'},   ← Few-shot 例
//     {role: 'user',      content: '昨日のゲームの続きやってる'}, ← 履歴
//     {role: 'assistant', content: 'いいね、進んでる？'},        ← 履歴
//     {role: 'user',      content: '今日は犬の話したい'}         ← 今回の発言
//   ]
//
// 順序が大事で、間違えると以下の問題が起きる：
// - Few-shot を履歴より後にすると、ライムが「Few-shot のセリフ」を直近の文脈と勘違いする
// - システムプロンプトを途中に入れると LLM が混乱する

'use strict';

// ─────────────────────────────────────────────
// システムプロンプト（ライムの性格定義）
// ─────────────────────────────────────────────
//
// これは全シーンで共通の基本性格。
// シーン固有の口調や雰囲気は Few-shot 例で表現する。
//
// 編集する時の注意:
// - 出力ルール（JSON形式）を変えると、サーバー側の normalizeLLMOutput() で
//   パースエラーが起きるようになる。連動して直す必要あり
// - 「お手伝いしましょうか？」禁止はかなり効くので消さない方がよい

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

/**
 * LLM に渡す messages 配列を構築する
 *
 * @param {Object} scene シーン定義オブジェクト
 *   - id: シーンID（例: "tired", "gaming"）
 *   - few_shots: Few-shot 対話例の配列 [{user, raim, emotion, intensity}, ...]
 * @param {string} userText 今回のユーザー発言
 * @param {Array<{role: string, content: string}>} history
 *   会話履歴（時系列順、最新が末尾）
 *   eventsToMessages() で MemoryStore から変換されたもの
 *
 * @returns {Array<{role: string, content: string}>} LLM 用 messages 配列
 */
function buildMessages(scene, userText, history = []) {
  // 1. システムプロンプトを先頭に置く
  const messages = [
    { role: 'system', content: SYSTEM_BASE }
  ];

  // 2. シーン固有の Few-shot を user/assistant 交互で並べる
  //
  // Few-shot とは「望ましい応答の例」をいくつか見せて、LLM にスタイルを学ばせる手法。
  // たとえば tired シーンなら「疲れた時はこう優しく返す」例を仕込む。
  // これは「過去の会話」ではなく「お手本」なので、履歴より前に置くのが定石。
  //
  // assistant 側を JSON.stringify するのは、出力ルールで JSON 形式を強制してるため。
  // 例で「JSON で返す」を見せると LLM が真似てくれる。
  if (scene && scene.few_shots) {
    for (const fs of scene.few_shots) {
      // ユーザー側の例
      messages.push({ role: 'user', content: fs.user });
      // ライム側の例（JSON 形式に整形）
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

  // 3. 会話履歴を時系列順で差し込む
  //
  // ここに過去の往復が入ることで「さっきの話」を覚えてる挙動になる。
  // 例:
  //   history = [
  //     {role: 'user', content: '犬が好き'},
  //     {role: 'assistant', content: '犬派なんだね'}
  //   ]
  // → 次に「犬種の話したい」と言われた時、ライムは前の発言を踏まえて返せる。
  for (const turn of history) {
    messages.push({
      role: turn.role,
      content: turn.content,
    });
  }

  // 4. 今回のユーザー発言を末尾に置く
  // LLM はこれに対する応答を生成する
  messages.push({ role: 'user', content: userText });

  return messages;
}

module.exports = { buildMessages };