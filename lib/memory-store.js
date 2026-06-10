// lib/memory-store.js
//
// 会話履歴の管理クラス。
// AWS Bedrock AgentCore Memory のインターフェースに似せた設計で、
// ローカルでは Map で保持し、本番では AgentCore Memory API に置き換える。
//
// 設計方針:
// - actorId / sessionId の概念を AgentCore Memory に揃える
// - 直近N往復の短期メモリのみ実装、長期メモリは本番で AgentCore に任せる
// - 永続化はしない（再起動で消える、本番で AgentCore が永続化担当）
// - 将来のマルチモーダル拡張を見越して content は Map 構造で保持

'use strict';

const { randomUUID } = require('crypto');

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

const MAX_SHORT_TERM_TURNS = 10;     // 直近の往復数（プロンプトに含める）
const SESSION_TTL_MS = 30 * 60 * 1000; // セッションのアイドルTTL（30分）

const Role = Object.freeze({
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
});

// ─────────────────────────────────────────────
// MemoryStore 抽象（本番でAWS実装を差し替える想定）
// ─────────────────────────────────────────────

const MODE = process.env.RAIM_MODE || 'local';

class MemoryStore {
  static create() {
    if (MODE === 'local') return new LocalMemoryStore();
    // 将来: return new AgentCoreMemoryStore({ memoryId: process.env.AGENTCORE_MEMORY_ID });
    throw new Error(`Unknown RAIM_MODE: ${MODE}`);
  }

  // ─── 抽象メソッド（サブクラスで実装） ───

  /**
   * セッション開始（既に存在すれば再利用）
   * @returns {Promise<{sessionId: string, isNew: boolean}>}
   */
  async startSession({ actorId, sessionId }) { throw new Error('not implemented'); }

  /**
   * イベント記録（1往復）
   * @param {Object} params
   * @param {string} params.actorId
   * @param {string} params.sessionId
   * @param {Array<{role: string, content: Object}>} params.payload
   */
  async createEvent({ actorId, sessionId, payload }) { throw new Error('not implemented'); }

  /**
   * 短期メモリ取得（直近のイベント一覧）
   * @returns {Promise<Array<{role: string, content: Object, timestamp: number}>>}
   */
  async listEvents({ actorId, sessionId, maxResults }) { throw new Error('not implemented'); }

  /**
   * 長期メモリ検索（Step 1ではスキップ、本番でAgentCore任せ）
   * @returns {Promise<Array>}
   */
  async retrieveMemoryRecords({ actorId, query, topK = 3 }) {
    return [];
  }
}

// ─────────────────────────────────────────────
// LocalMemoryStore: Map ベースの実装
// ─────────────────────────────────────────────

class LocalMemoryStore extends MemoryStore {
  constructor() {
    super();
    // sessionId -> {actorId, events: [...], lastAccessedAt}
    this._sessions = new Map();

    // TTL クリーンアップを定期実行（5分ごと）
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  async startSession({ actorId, sessionId }) {
    if (sessionId && this._sessions.has(sessionId)) {
      // 既存セッションを使う
      const session = this._sessions.get(sessionId);
      session.lastAccessedAt = Date.now();
      return { sessionId, isNew: false };
    }

    // 新規セッション
    const newId = sessionId || `session_${randomUUID()}`;
    this._sessions.set(newId, {
      actorId,
      events: [],
      lastAccessedAt: Date.now(),
    });
    return { sessionId: newId, isNew: true };
  }

  async createEvent({ actorId, sessionId, payload }) {
    let session = this._sessions.get(sessionId);
    if (!session) {
      // セッション未登録なら作る
      await this.startSession({ actorId, sessionId });
      session = this._sessions.get(sessionId);
    }

    const timestamp = Date.now();
    // payload は [{role, content}, ...] の配列、複数ターンを1イベントとして記録
    for (const turn of payload) {
      session.events.push({
        role: turn.role,
        content: turn.content,
        timestamp,
      });
    }

    session.lastAccessedAt = timestamp;
  }

  async listEvents({ actorId, sessionId, maxResults = MAX_SHORT_TERM_TURNS * 2 }) {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    if (session.actorId !== actorId) return []; // 他人のセッションは見せない

    session.lastAccessedAt = Date.now();

    // 直近 N 件を返す
    const all = session.events;
    return all.slice(-maxResults);
  }

  // ─── 内部ヘルパ ───

  _cleanupExpired() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions.entries()) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        this._sessions.delete(sessionId);
        // ignore: avoid_print
        console.log(`[MemoryStore] Session expired: ${sessionId}`);
      }
    }
  }

  // 統計用（デバッグやログに使える）
  _stats() {
    return {
      sessionCount: this._sessions.size,
      totalEvents: Array.from(this._sessions.values())
        .reduce((sum, s) => sum + s.events.length, 0),
    };
  }
}

// ─────────────────────────────────────────────
// 便利関数: イベント配列を LLM messages 配列に変換
// content は {text: "..."} の形式（将来は image も入る）
// ─────────────────────────────────────────────

/**
 * MemoryStore のイベントを LLM の messages 配列に変換
 * Few-shot との結合は prompt-builder 側で行う
 *
 * @param {Array<{role: string, content: Object}>} events
 * @returns {Array<{role: string, content: string}>}
 */
function eventsToMessages(events) {
  return events.map(event => ({
    role: event.role === Role.USER ? 'user' : 'assistant',
    content: event.content.text || '',
    // 将来: content が画像を含む場合、Ollama/Bedrock の multimodal フォーマットに変換
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