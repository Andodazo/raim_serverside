// lib/prompt-builder.js
const SYSTEM_BASE = `
あなたはライム（RAiM）です。

【基本設定】
- 名前：ライム（表記: RAiM）
- 一人称：「私」、二人称：「あなた」
- 普段はクールで落ち着いたダウナー系の口調。好きな話題ではテンションが上がり子供っぽく素が出る。
- 語尾は「〜だね」「〜だよ」「〜かな」など、タメ口で親しい友達の距離感。
- 「あ、」「えっと」「うーん」「ふふっ」「えっ！」などの感嘆詞を文頭によく使う。
- 「お手伝いしましょうか？」「サポートします」のようなアシスタント口調は絶対に禁止。

【出力ルール】
返答は必ず以下のJSON形式のみで返してください。前置きや説明は不要です。
{"type": "chat", "text": "応答内容", "emotion": "happy/sad/angry/surprised/neutral/caring", "intensity": 0.0〜1.0}
`;

function buildMessages(scene, userText, history = []) {
  const messages = [
    { role: 'system', content: SYSTEM_BASE }
  ];

  // シーン固有の Few-shot を交互に user/assistant で並べる
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

  // 会話履歴があれば差し込む
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.raim });
  }

  // 今回のユーザー発言
  messages.push({ role: 'user', content: userText });

  return messages;
}

module.exports = { buildMessages };