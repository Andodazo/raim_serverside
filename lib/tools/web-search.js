// lib/tools/web-search.js
// ==============================================================================
// Tavily API を使った Web 検索ツール
// ==============================================================================
//
// 【API ドキュメント】
// https://docs.tavily.com/docs/rest-api/api-reference
//
// 【無料枠】
// 1,000 queries/月
//
// 【特徴】
// - LLM 用に最適化されている
// - "answer" フィールドにサマリが入る（そのまま LLM に渡せる）
// - "results" に検索結果のスニペット配列
// - 日本語クエリも対応
//
// 【抽象化】
// 将来 Serper / Brave / 他 API に切り替える時は、このファイル内だけ変更すれば良い。
// 返り値の構造を統一しておくことで、tools/index.js 以下は変更不要。

'use strict';

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Tavily で Web 検索を実行
 *
 * @param {string} query 検索クエリ
 * @param {number} maxResults 最大結果件数（デフォルト3）
 * @returns {Promise<Object>} 検索結果
 *   {
 *     query: string,
 *     answer: string | null,       // Tavily が生成したサマリ
 *     results: [{title, url, content, score}],
 *     count: number,
 *   }
 */
async function searchWeb(query, maxResults = 3) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set in .env');
  }
  if (!query || typeof query !== 'string') {
    throw new Error('query is required and must be a string');
  }

  // max_results は 1〜10 でクランプ
  const limit = Math.max(1, Math.min(10, maxResults || 3));

  const requestBody = {
    api_key: apiKey,
    query: query,
    max_results: limit,
    // Tavily の便利機能:
    include_answer: true,    // LLM 用サマリ生成（基本機能、無料枠で利用可）
    // include_raw_content: false,  // 生HTML不要、トークン節約
    // search_depth: "basic",       // "basic" or "advanced"（advanced は2クレジット消費）
  };

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tavily API error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  // 結果を整形して返す（プロバイダー抽象化のため統一構造に）
  return {
    query: data.query || query,
    answer: data.answer || null,
    results: (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.content,   // スニペット
      score: r.score,
    })),
    count: (data.results || []).length,
  };
}

module.exports = { searchWeb };