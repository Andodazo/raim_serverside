// lib/tools/get-weather.js
// ==============================================================================
// OpenWeatherMap API を使った天気取得ツール
// ==============================================================================
//
// 【API ドキュメント】
// https://openweathermap.org/current
//
// 【無料枠】
// 1,000 calls/日（卒研用途には十分すぎる）
//
// 【特徴】
// - 都市名から現在の天気・気温・湿度を取得
// - レスポンスが JSON で構造化されてる（Web 検索より整形しやすい）
// - 日本語都市名は API がジオコーディングしてくれる
//
// 【データの単位】
// - units=metric: 摂氏℃（推奨、日本向け）
// - lang=ja: 天気説明を日本語化

'use strict';

const OWM_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

/**
 * OpenWeatherMap で都市の現在天気を取得
 *
 * @param {string} city 都市名（日本語/英語、例: "東京" "Tokyo"）
 * @param {string} [countryCode] ISO 3166 国コード（省略可、例: "JP"）
 * @returns {Promise<Object>} 天気情報
 *   {
 *     city: string,
 *     country: string,
 *     weather: string,         // "晴れ" "曇り" 等
 *     description: string,     // より詳細な説明
 *     temp: number,            // 気温（℃）
 *     feels_like: number,      // 体感温度（℃）
 *     humidity: number,        // 湿度（%）
 *     wind_speed: number,      // 風速（m/s）
 *     timestamp: string,       // ISO 8601 形式の取得時刻
 *   }
 */
async function getWeather(city, countryCode = null) {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    throw new Error('OPENWEATHERMAP_API_KEY is not set in .env');
  }
  if (!city || typeof city !== 'string') {
    throw new Error('city is required and must be a string');
  }

  // q パラメータの組み立て
  // 国コード省略時はそのまま都市名のみ
  const queryParam = countryCode ? `${city},${countryCode}` : city;

  // URL 組み立て
  const url = new URL(OWM_API_URL);
  url.searchParams.set('q', queryParam);
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');  // 摂氏
  url.searchParams.set('lang', 'ja');       // 天気説明を日本語化

  const res = await fetch(url.toString());

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`都市が見つかりません: ${city}`);
    }
    if (res.status === 401) {
      throw new Error('OPENWEATHERMAP_API_KEY が無効、または有効化前です（登録後数時間〜半日かかる場合あり）');
    }
    const errText = await res.text();
    throw new Error(`OpenWeatherMap API error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  // 結果を整形して返す
  // OpenWeatherMap の生レスポンスは情報過多なので、必要なフィールドだけ抽出
  return {
    city: data.name,
    country: data.sys?.country || 'unknown',
    weather: data.weather?.[0]?.main || 'unknown',         // 英語の大分類: "Clear", "Clouds", "Rain"
    description: data.weather?.[0]?.description || '',     // 日本語の詳細: "晴天", "曇りがち" 等
    temp: Math.round(data.main?.temp ?? 0),               // 気温（整数に丸め）
    feels_like: Math.round(data.main?.feels_like ?? 0),   // 体感温度
    humidity: data.main?.humidity ?? 0,                    // 湿度
    wind_speed: data.wind?.speed ?? 0,                     // 風速
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getWeather };