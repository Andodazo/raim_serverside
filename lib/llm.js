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
// 【v6 での変更点】
// - callLLMStreamWithTools 追加
//   tools 付きで stream:true 呼出し、イベント形式で yield する
//   Ollama 0.32.1 で Gemma 4 の tool calling / multi-turn reasoning が改善されたため、
//   従来「不安定」としていた streaming + tools の併用が現実的になった
//
// 【既存 3 関数は変更なし】
// - callLLM          : stream:false, format:'json', tools なし
// - callLLMStream    : stream:true,  format:'json', tools なし
// - callLLMWithTools : stream:false, tools あり（format:'json' は付けない）
//
// 【format:'json' を tools 使用時に付けない理由（v5 からの継承）】
// Ollama が tool_calls 形式で応答を返すため、追加の JSON 強制は不要。
// 本文を返す場合の JSON 形式遵守は system プロンプト側の指示で担保している。
// callLLMStreamWithTools もこの方針を踏襲する。
//
// 【v7 での変更点】
// 1. num_ctx を明示指定する
//    Ollama は options.num_ctx を指定しないと既定値（従来 4096）を使う。
//    モデル自体の context length が 262144 でも、リクエスト側で絞られる。
//    RAiM のプロンプトは
//      システムプロンプト（12感情の説明 + ツール説明 + 出力ルール）
//      + Few-shot 4組 + 会話履歴 + ツール実行結果
//    という構成で、特に web_search の結果が乗ると 4096 を超えやすい。
//    溢れた分は先頭から捨てられるため、真っ先に消えるのが
//    「JSON 形式で返せ」というシステムプロンプトそのものになり、
//    指示を失った Gemma が空応答を返す（= 実際に観測された症状）。
//    OLLAMA_NUM_CTX で調整可能、既定 8192。
//
// 2. トークン使用量ログ
//    ストリーム終了時に prompt_eval_count（入力トークン数）と
//    eval_count（出力トークン数）を出す。
//    prompt_eval_count が num_ctx に張り付いていたら切り詰めが起きている。
//    LLM_USAGE_LOG=false で黙らせられる。
//
// 【既存 4 関数のシグネチャは変更なし】
// - callLLM                 : stream:false, format:'json', tools なし
// - callLLMStream           : stream:true,  format:'json', tools なし
// - callLLMWithTools        : stream:false, tools あり（format:'json' は付けない）
// - callLLMStreamWithTools  : stream:true,  tools あり（同上）
//
// 【format:'json' を tools 使用時に付けない理由（v5 からの継承）】
// Ollama が tool_calls 形式で応答を返すため、追加の JSON 強制は不要。
// 本文を返す場合の JSON 形式遵守は system プロンプト側の指示で担保している。
// 【v8 での変更点 — thinking の用途別制御】
// Ollama の /api/chat はリクエスト直下に think フラグを取れる。
// Gemma 4 は thinking 対応モデルなので、指定しないと毎回思考が走る。
//
// 実測: 本文生成で output=77 トークンに対し 26 秒かかっていた。
// 12B が 77 トークン吐くだけなら 2〜3 秒で済むので、
// 残りはすべて「誰にも見られない思考」に消えていた計算になる。
// （callLLMStream は msg.thinking を拾っていなかったため、
//   思考が走っていること自体がログに出ていなかった）
//
// そこで用途で分ける:
//   ツール判断（callLLMWithTools / callLLMStreamWithTools）→ thinking ON
//     「どのツールをどの引数で呼ぶか」の判断精度に効いている可能性があるため残す
//   本文生成（callLLM / callLLMStream）→ thinking OFF
//     キャラとして喋るだけなので長考は要らない
//
// 環境変数:
//   RAIM_THINKING_TOOLS=false  ツール判断の thinking も切る
//   RAIM_THINKING_BODY=true    本文生成でも thinking を有効にする（検証用）
//
// v8 では callLLMStream でも thinking を拾ってログに出すようにした。
// OFF が効いていれば thinking のログが消える。
//
// 【v7 からの継承】
// 1. num_ctx を明示指定する
//    Ollama は options.num_ctx を指定しないと既定値（従来 4096）を使う。
//    web_search の結果が乗ると 4096 を超えやすく、溢れた分は先頭から
//    捨てられるため、真っ先に消えるのが「JSON 形式で返せ」という
//    システムプロンプトそのものになり、Gemma が空応答を返す。
//    OLLAMA_NUM_CTX で調整可能、既定 8192。
// 2. トークン使用量ログ（prompt_eval_count / eval_count）
//
// 【4 関数のシグネチャは変更なし】
// - callLLM                 : stream:false, format:'json', tools なし, think OFF
// - callLLMStream           : stream:true,  format:'json', tools なし, think OFF
// - callLLMWithTools        : stream:false, tools あり, think ON
// - callLLMStreamWithTools  : stream:true,  tools あり, think ON
//
// 【format:'json' を tools 使用時に付けない理由（v5 からの継承）】
// Ollama が tool_calls 形式で応答を返すため、追加の JSON 強制は不要。
// 本文を返す場合の JSON 形式遵守は system プロンプト側の指示で担保している。

const MODE = process.env.RAIM_MODE || 'local';

// コンテキスト長。プロンプトがこれを超えると先頭から切り詰められる。
// VRAM とのトレードオフ: 大きくするほど KV キャッシュが増える。
// RTX 4070 (12GB) + gemma4:12b Q4_K_M (7.6GB) なら 8192 は余裕、16384 も試せる範囲。
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);

// thinking の用途別制御
const THINKING_TOOLS = process.env.RAIM_THINKING_TOOLS !== 'false';  // 既定 ON
const THINKING_BODY = process.env.RAIM_THINKING_BODY === 'true';     // 既定 OFF

// トークン使用量ログ（既定 ON）
const USAGE_LOG = process.env.LLM_USAGE_LOG !== 'false';

const LLM_OPTIONS = {
  temperature: 1.0,
  top_p: 0.95,
  top_k: 64,
  num_ctx: NUM_CTX,
};

/**
 * Ollama の応答から使用トークン数をログ出力する
 *
 * prompt_eval_count が num_ctx 付近に張り付いている場合、
 * プロンプトが切り詰められている可能性が高い。
 */
function logUsage(label, data) {
  if (!USAGE_LOG || !data) return;
  const prompt = data.prompt_eval_count;
  const output = data.eval_count;
  if (prompt === undefined && output === undefined) return;

  const ratio = prompt ? Math.round((prompt / NUM_CTX) * 100) : 0;
  const warn = prompt && prompt >= NUM_CTX * 0.9 ? '  ⚠ near num_ctx limit' : '';
  console.log(
    `  [LLM] ${label}: prompt=${prompt ?? '?'} / num_ctx=${NUM_CTX} (${ratio}%), ` +
    `output=${output ?? '?'}${warn}`
  );
}

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
        think: THINKING_BODY,
        options: LLM_OPTIONS,
      }),
    });
    if (!res.ok) throw new Error(`Ollama LLM error: ${res.status}`);
    const data = await res.json();
    logUsage('callLLM', data);
    return data.message.content;
  } else {
    throw new Error('AWS mode not implemented yet');
  }
}

// ─────────────────────────────────────────────
// ストリーミング呼出（tools なし）
// ─────────────────────────────────────────────

async function* callLLMStream(messages) {
  if (MODE !== 'local') {
    throw new Error('AWS streaming mode not implemented yet');
  }

  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_LLM_MODEL,
      messages,
      stream: true,
      format: 'json',
      think: THINKING_BODY,
      options: LLM_OPTIONS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama LLM stream error: ${res.status}`);
  }

  // thinking が走っているかを検知する。
  // think:false が効いていればここは 0 のままになる。
  // 0 でないのに本文が遅い場合は、思考に時間を食われている。
  let thinkingChars = 0;

  for await (const chunk of iterateNdjson(res)) {
    if (chunk.message && chunk.message.thinking) {
      thinkingChars += chunk.message.thinking.length;
    }
    if (chunk.message && chunk.message.content) {
      yield chunk.message.content;
    }
    if (chunk.done) {
      if (thinkingChars > 0) {
        console.log(`  [LLM] callLLMStream: thinking ${thinkingChars} chars (think flag not honored?)`);
      }
      logUsage('callLLMStream', chunk);
      return;
    }
  }
}

// ─────────────────────────────────────────────
// Function Calling 用呼出（stream:false）
// ─────────────────────────────────────────────

async function callLLMWithTools(messages, tools) {
  if (MODE !== 'local') {
    throw new Error('AWS function calling mode not implemented yet');
  }

  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_LLM_MODEL,
      messages,
      tools,
      stream: false,
      think: THINKING_TOOLS,
      options: LLM_OPTIONS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama LLM with tools error: ${res.status}`);
  }

  const data = await res.json();
  const msg = data.message || {};
  logUsage('callLLMWithTools', data);

  return {
    content: msg.content || '',
    thinking: msg.thinking || null,
    tool_calls: msg.tool_calls || null,
  };
}

// ─────────────────────────────────────────────
// Function Calling + ストリーミング（v6 新規）
// ─────────────────────────────────────────────

/**
 * tools 付きで stream:true 呼出し、イベントを順次 yield する
 *
 * 【yield されるイベント】
 *   { type: 'thinking',   content: string }      Gemma 4 の思考プロセス（増分）
 *   { type: 'token',      content: string }      本文トークン（増分）
 *   { type: 'tool_calls', tool_calls: Array }    ツール呼出（到着時点で完全な配列）
 *   { type: 'done' }                             ストリーム終了
 *
 * 【呼び出し側の想定フロー】
 * token を受け取ったら StreamingTextExtractor に feed して text_chunk として送信する。
 * tool_calls が来たらツール実行へ分岐する。
 *
 * Gemma 4 は tool_calls を返すとき content が空になる傾向があるため、
 * 通常は「token が1つも来ないまま tool_calls が来る」か
 * 「tool_calls が来ないまま token が流れ続ける」のどちらかになる。
 * ただし両方来る可能性はゼロではないので、呼び出し側で順序を意識して扱うこと。
 *
 * @param {Array} messages
 * @param {Array} tools
 */
async function* callLLMStreamWithTools(messages, tools) {
  if (MODE !== 'local') {
    throw new Error('AWS streaming function calling not implemented yet');
  }

  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_LLM_MODEL,
      messages,
      tools,
      stream: true,
      // format:'json' は付けない（callLLMWithTools と同じ方針）
      think: THINKING_TOOLS,
      options: LLM_OPTIONS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama LLM stream with tools error: ${res.status}`);
  }

  // tool_calls は複数チャンクに分かれて届く可能性があるので蓄積する
  let accumulatedToolCalls = null;

  for await (const chunk of iterateNdjson(res)) {
    const msg = chunk.message || {};

    if (msg.thinking) {
      yield { type: 'thinking', content: msg.thinking };
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      accumulatedToolCalls = (accumulatedToolCalls || []).concat(msg.tool_calls);
    }

    if (msg.content) {
      yield { type: 'token', content: msg.content };
    }

    if (chunk.done) {
      logUsage('callLLMStreamWithTools', chunk);
      if (accumulatedToolCalls && accumulatedToolCalls.length > 0) {
        yield { type: 'tool_calls', tool_calls: accumulatedToolCalls };
        accumulatedToolCalls = null;
      }
      yield { type: 'done' };
      return;
    }
  }

  // done フラグなしでストリームが終了した場合の保険
  if (accumulatedToolCalls && accumulatedToolCalls.length > 0) {
    yield { type: 'tool_calls', tool_calls: accumulatedToolCalls };
  }
  yield { type: 'done' };
}

// ─────────────────────────────────────────────
// 内部: Ollama の NDJSON ストリームを1行ずつパースする共通処理
// ─────────────────────────────────────────────

async function* iterateNdjson(res) {
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
          yield JSON.parse(line);
        } catch (e) {
          console.warn('[LLM Stream] Parse warning:', e.message);
        }
      }
    }

    if (buffer.trim().length > 0) {
      try {
        yield JSON.parse(buffer);
      } catch (e) {
        console.warn('[LLM Stream] Final buffer parse warning:', e.message);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

module.exports = {
  callLLM,
  callLLMStream,
  callLLMWithTools,
  callLLMStreamWithTools,
  LLM_OPTIONS,
  NUM_CTX,
  THINKING_TOOLS,
  THINKING_BODY,
};