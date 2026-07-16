// lib/tools/index.js
// ==============================================================================
// ツールレジストリ：LLM に渡すツール定義 + 実行関数の管理
// ==============================================================================
//
// 【このファイルの役割】
// Function Calling で使うツールを一元管理する。
// - LLM に渡す JSON Schema 形式の tool 定義（Gemma 4 が理解できる形式）
// - サーバー側で実行する関数の呼出
//
// 【拡張方法】
// 新しいツール（例：calendar、translator）を追加する時:
// 1. lib/tools/<tool-name>.js を新規作成
// 2. ここの TOOLS と TOOL_INTROS に登録するだけ
//
// 【設計思想】
// - 各ツールは independent（他のツールに依存しない）
// - エラー時は throw、呼出側でハンドリング
// - 引数は LLM が JSON で渡してくるので、文字列正規化が必要
// lib/tools/index.js
// ==============================================================================
// ツールレジストリ：LLM に渡すツール定義 + 実行関数の管理
// ==============================================================================
//
// 【v14_fix での変更点】
// - executeTool の unknown tool 処理を変更
//   throw → error result 返す（サーバー落ちない）
//   Gemma 4 が "tool_result" 等の捏造ツール名を呼んできても
//   LLM に「そんなツールないよ」の error result を渡して自然応答させる

'use strict';

const { searchWeb } = require('./web-search');
const { getWeather } = require('./get-weather');

// ─────────────────────────────────────────────
// ツール定義（LLM に渡す JSON Schema）
// ─────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Web 検索を実行して最新情報を取得します。最新ニュース、雑学、知らないトピック、調べ物に使ってください。天気や時刻はこのツールを使わず、専用ツールを使ってください。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '検索クエリ（日本語または英語、できるだけ具体的に）',
          },
          max_results: {
            type: 'integer',
            description: '結果の最大件数（デフォルト3）',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '指定された都市の現在の天気情報を取得します。Web検索より構造化された天気データを返します。',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '都市名（例：東京、Tokyo、Osaka）。日本語/英語どちらでも可',
          },
          country_code: {
            type: 'string',
            description: 'ISO 3166 国コード（例：JP）。省略可、日本の都市は不要',
          },
        },
        required: ['city'],
      },
    },
  },
];

// ツール実行関数のマッピング
const TOOL_FUNCTIONS = {
  web_search: async (args) => {
    return await searchWeb(args.query, args.max_results);
  },
  get_weather: async (args) => {
    return await getWeather(args.city, args.country_code);
  },
};

// 有効なツール名のセット（バリデーション用）
const VALID_TOOL_NAMES = new Set(Object.keys(TOOL_FUNCTIONS));

// ─────────────────────────────────────────────
// 前置きセリフ
// ─────────────────────────────────────────────

const TOOL_INTROS = {
  web_search: {
    first: [
      'んー、ちょっと調べてみるね',
      'えっと、それ気になる。少し待って？',
      'あ、それ調べた方がいいな。ちょっと待って',
      'うーん、調べてみるよ',
    ],
    second: [
      'もう少し詳しく調べてみる',
      'ふむふむ、もうちょっと深掘りするね',
      'んー、別の角度からも見てみる',
    ],
    third: [
      '念のため、もうちょっと確認する',
      'えっと、最後に確認させて',
    ],
  },
  get_weather: {
    first: [
      '天気見てくる、ちょっと待って',
      'んー、天気ね。今チェックする',
      'あ、空のこと？調べるよ',
    ],
    second: [
      '他の地域の天気も確認するね',
      '別の天気情報も見てみる',
    ],
    third: [
      '念のため、もう一回見てみる',
    ],
  },
};

function pickToolIntro(toolName, turn) {
  const intros = TOOL_INTROS[toolName];
  if (!intros) {
    // 未知のツール用フォールバック
    return 'えっと、ちょっと待って';
  }
  const key = turn === 1 ? 'first' : turn === 2 ? 'second' : 'third';
  const pool = intros[key] || intros.first;
  return pool[Math.floor(Math.random() * pool.length)];
}

const TOOL_DESCRIPTIONS = {
  web_search: (args) => `「${args.query || ''}」を検索しています`,
  get_weather: (args) => `${args.city || ''}の天気を調べています`,
};

function getToolDescription(toolName, args) {
  const fn = TOOL_DESCRIPTIONS[toolName];
  return fn ? fn(args) : `${toolName} を実行しています`;
}

/**
 * ツール名が有効か判定
 * v14_fix: server.js から呼び出して、捏造ツール名の早期検知に使う
 */
function isValidToolName(toolName) {
  return VALID_TOOL_NAMES.has(toolName);
}

// ─────────────────────────────────────────────
// ツール実行（v14_fix 修正版）
// ─────────────────────────────────────────────

/**
 * ツールを実行して結果を返す
 *
 * v14_fix での変更:
 * - unknown tool の場合、throw じゃなく error result を返す
 * - これで Gemma 4 が "tool_result" 等の捏造ツール名を呼んでもサーバー落ちない
 * - LLM は tool ロールで返ってきた error を見て「ツール失敗した」と認識し、
 *   強制応答フローで自然な応答を生成する
 */
async function executeTool(toolName, args) {
  const fn = TOOL_FUNCTIONS[toolName];

  if (!fn) {
    // v14_fix: 存在しないツール名でも throw じゃなく error result 返す
    console.warn(`[Tool] Unknown tool: "${toolName}" (LLM may have hallucinated). Returning error result.`);
    return {
      error: true,
      message: `Unknown tool: ${toolName}. Available tools: ${Array.from(VALID_TOOL_NAMES).join(', ')}`,
      tool: toolName,
      hallucinated: true,
    };
  }

  console.log(`[Tool] Executing ${toolName}(${JSON.stringify(args)})`);
  const t0 = Date.now();

  try {
    const result = await fn(args);
    const t1 = Date.now();
    console.log(`[Tool] ${toolName} completed in ${t1 - t0}ms`);
    return result;
  } catch (e) {
    console.error(`[Tool] ${toolName} failed: ${e.message}`);
    return {
      error: true,
      message: e.message,
      tool: toolName,
    };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  pickToolIntro,
  getToolDescription,
  isValidToolName,       // v14_fix 新規
  VALID_TOOL_NAMES,      // v14_fix 新規
};