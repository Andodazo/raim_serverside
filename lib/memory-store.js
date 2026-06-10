// lib/memory-store.js
// ==============================================================================
// 会話履歴の管理クラス
// ==============================================================================
//
// 【このファイルの役割】
// ライムとユーザーの会話履歴を保持し、毎回のプロンプトに直近の往復を差し込めるようにする。
// これがあることで、ライムが「さっき犬の話してたよね」みたいに文脈を持って会話できる。
//
// 【設計の前提】
// 本番では AWS Bedrock AgentCore Memory を使う方針。
// AgentCore Memory には「短期メモリ（直近の対話）」と「長期メモリ（過去の好み・要約）」の2種類があり、
// 自動で抽出・保存・検索してくれる。
//
// ローカル開発では AgentCore は動かないので、同じインターフェースで動く簡易版を Map で実装する。
// 本番に移行する時は、このクラスの中身を AgentCore API 呼び出しに差し替えるだけで済む設計。
//
// 【AgentCore Memory との対応】
//   ローカル                          本番(AWS)
//   -----------                       --------------------------------------
//   startSession({actorId, ...})  ⇔  AgentCore: セッション開始
//   createEvent({...})            ⇔  AgentCore data_client.create_event(...)
//   listEvents({...})             ⇔  AgentCore data_client.list_events(...)
//   retrieveMemoryRecords(...)    ⇔  AgentCore data_client.retrieve_memory_records(...)
//
// 【スキップしているもの】
// - 永続化（再起動でメモリ消える） → 本番では AgentCore が永続化担当
// - 長期メモリ検索 → retrieveMemoryRecords() は空配列を返す。本番で AgentCore が自動抽出
// - Strategy管理（要約・好み抽出）→ 本番で AgentCore が自動

'use strict';

const { randomUUID } = require('crypto');

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

// 直近何往復分をプロンプトに含めるか
// 多すぎるとトークン数が爆発し、Lost in the middle 現象でモデルが取りこぼす
// 10 = 「直前の会話の流れ」を覚えるには十分、トークンも現実的な範囲
const MAX_SHORT_TERM_TURNS = 10;

// セッションのアイドルTTL（最後にアクセスしてからこの時間で削除）
// 短すぎると一旦離席して戻ったらライムが「初めまして」状態になって不自然
// 長すぎるとメモリリーク懸念
// 30分が現実的なバランス
const SESSION_TTL_MS = 30 * 60 * 1000;

// 発言者のロール（AgentCore Memory の payload 仕様に揃える）
const Role = Object.freeze({
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
});

// ─────────────────────────────────────────────
// MemoryStore 抽象クラス
// ─────────────────────────────────────────────
//
// 環境変数 RAIM_MODE で切り替える：
//   local → LocalMemoryStore（Map ベース、開発用）
//   aws   → AgentCoreMemoryStore（将来実装）

const MODE = process.env.RAIM_MODE || 'local';

class MemoryStore {
  /**
   * ファクトリ：環境に応じた MemoryStore を返す
   */
  static create() {
    if (MODE === 'local') return new LocalMemoryStore();
    // 将来の AWS 実装：
    // return new AgentCoreMemoryStore({ memoryId: process.env.AGENTCORE_MEMORY_ID });
    throw new Error(`Unknown RAIM_MODE: ${MODE}`);
  }

  // ─── 抽象メソッド（サブクラスで実装する） ───

  /**
   * セッション開始
   * - 既存のセッションIDが渡されたら、それを再利用（lastAccessedAt 更新）
   * - 渡されなかった or 存在しなければ新規発行
   *
   * @param {Object} params
   * @param {string} params.actorId   ユーザー識別子（誰の記憶か）
   * @param {string|null} params.sessionId  セッション識別子（指定なければ自動発行）
   * @returns {Promise<{sessionId: string, isNew: boolean}>}
   */
  async startSession({ actorId, sessionId }) { throw new Error('not implemented'); }

  /**
   * イベント記録（1往復＝user発言＋assistant応答を一緒に記録）
   *
   * @param {Object} params
   * @param {string} params.actorId
   * @param {string} params.sessionId
   * @param {Array<{role: string, content: Object}>} params.payload
   *   content は将来のマルチモーダル対応で {text, image} の構造も入る
   */
  async createEvent({ actorId, sessionId, payload }) { throw new Error('not implemented'); }

  /**
   * 短期メモリ取得（直近のイベント一覧）
   * これを LLM のプロンプトに含めることで「直前の話題」が伝わる
   *
   * @returns {Promise<Array<{role: string, content: Object, timestamp: number}>>}
   */
  async listEvents({ actorId, sessionId, maxResults }) { throw new Error('not implemented'); }

  /**
   * 長期メモリ検索（Embedding ベースの意味検索）
   * Step 1 ではスキップ、本番で AgentCore が自動抽出して検索結果を返す
   *
   * @returns {Promise<Array>}
   */
  async retrieveMemoryRecords({ actorId, query, topK = 3 }) {
    return [];
  }
}

// ─────────────────────────────────────────────
// LocalMemoryStore: Map ベースのローカル実装
// ─────────────────────────────────────────────
//
// データ構造:
//   _sessions: Map<sessionId, {
//     actorId: string,
//     events: Array<{role, content, timestamp}>,
//     lastAccessedAt: number  // TTLクリーンアップ用
//   }>
//
// メモリだけ保持なので、サーバー再起動で全部消える。
// 本番の AgentCore Memory に置き換える時は、ここを丸ごと差し替える。

class LocalMemoryStore extends MemoryStore {
  constructor() {
    super();
    // sessionId -> セッションデータ の Map
    this._sessions = new Map();

    // 5分ごとに期限切れセッションを削除（メモリリーク防止）
    // unref() を呼ぶと、このタイマーがあってもプロセスは終了できる（テスト時など）
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * セッション開始
   * - sessionId が指定され、既に存在すれば再利用
   * - そうでなければ UUID で新規発行
   */
  async startSession({ actorId, sessionId }) {
    // 既存セッションの再利用
    if (sessionId && this._sessions.has(sessionId)) {
      const session = this._sessions.get(sessionId);
      session.lastAccessedAt = Date.now();  // TTLリセット
      return { sessionId, isNew: false };
    }

    // 新規セッション作成
    // UUID にプレフィックスをつけて識別しやすく
    const newId = sessionId || `session_${randomUUID()}`;
    this._sessions.set(newId, {
      actorId,
      events: [],
      lastAccessedAt: Date.now(),
    });
    return { sessionId: newId, isNew: true };
  }

  /**
   * イベント記録
   * payload は [{role: USER, content: {...}}, {role: ASSISTANT, content: {...}}]
   * のような複数ターンの配列で受け取る
   */
  async createEvent({ actorId, sessionId, payload }) {
    let session = this._sessions.get(sessionId);

    // セッションが存在しなければ自動作成
    // （Flutter 側から知らない sessionId が送られてきた時の防御）
    if (!session) {
      await this.startSession({ actorId, sessionId });
      session = this._sessions.get(sessionId);
    }

    const timestamp = Date.now();

    // payload の各ターンをイベントとして追加
    // 1回の createEvent で「ユーザー発言＋ライム応答」をまとめて記録するのが一般的
    for (const turn of payload) {
      session.events.push({
        role: turn.role,
        content: turn.content,
        timestamp,
      });
    }

    session.lastAccessedAt = timestamp;
  }

  /**
   * 短期メモリ取得
   * 直近 N 件のイベントを時系列順で返す（古い→新しい）
   * デフォルトは MAX_SHORT_TERM_TURNS * 2（user/assistant ペアでN往復分）
   */
  async listEvents({ actorId, sessionId, maxResults = MAX_SHORT_TERM_TURNS * 2 }) {
    const session = this._sessions.get(sessionId);
    if (!session) return [];

    // 別ユーザーのセッションを見せないよう防御（将来の認証で重要）
    if (session.actorId !== actorId) return [];

    session.lastAccessedAt = Date.now();

    // 直近 N 件を返す（配列の末尾から N 個）
    return session.events.slice(-maxResults);
  }

  // ─── 内部ヘルパ ───

  /**
   * 期限切れセッションの削除
   * 5分おきに呼ばれる
   */
  _cleanupExpired() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions.entries()) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        this._sessions.delete(sessionId);
        console.log(`[MemoryStore] Session expired: ${sessionId}`);
      }
    }
  }

  /**
   * 統計情報（デバッグ・運用ログ用）
   * 例：エンドポイントで /stats を返す時に使える
   */
  _stats() {
    return {
      sessionCount: this._sessions.size,
      totalEvents: Array.from(this._sessions.values())
        .reduce((sum, s) => sum + s.events.length, 0),
    };
  }
}

// ─────────────────────────────────────────────
// 便利関数: MemoryStoreのイベントをLLM messages 配列に変換
// ─────────────────────────────────────────────

/**
 * MemoryStore に格納されたイベントを、LLMに渡す messages 配列の形に変換する
 *
 * MemoryStore のイベント形式:
 *   { role: 'USER', content: {text: '...'}, timestamp: ... }
 *
 * LLM の messages 形式:
 *   { role: 'user', content: '...' }
 *
 * 変換ポイント:
 * - role を大文字 USER/ASSISTANT → 小文字 user/assistant に
 * - content.text を取り出して content フィールドに展開
 *
 * 将来のマルチモーダル対応:
 * - content に image が含まれる場合は、Ollama/Bedrock それぞれの形式に変換する処理を追加
 *
 * @param {Array<{role: string, content: Object}>} events
 * @returns {Array<{role: string, content: string}>}
 */
function eventsToMessages(events) {
  return events.map(event => ({
    role: event.role === Role.USER ? 'user' : 'assistant',
    content: event.content.text || '',
    // 将来：event.content.image があれば multimodal フォーマットに変換
  }));
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  MemoryStore,
  LocalMemoryStore,
  Role,
  eventsToMessages,
  MAX_SHORT_TERM_TURNS,
};