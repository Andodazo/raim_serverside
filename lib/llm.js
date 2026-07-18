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

const MODE = process.env.RAIM_MODE || 'local';

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
      options: LLM_OPTIONS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama LLM stream error: ${res.status}`);
  }

  for await (const chunk of iterateNdjson(res)) {
    if (chunk.message && chunk.message.content) {
      yield chunk.message.content;
    }
    if (chunk.done) return;
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
      options: LLM_OPTIONS,
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
};