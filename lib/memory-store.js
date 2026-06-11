// lib/memory-store.js
// ==============================================================================
// 会話履歴の管理クラス（マルチモーダル対応版）
// ==============================================================================
//
// 【このファイルの役割】
// ライムとユーザーの会話履歴を保持し、毎回のプロンプトに直近の往復を差し込めるようにする。
// マルチモーダル対応版では、画像の説明テキストを履歴に埋め込む形で保存する。
//
// 【画像を含む発言の保存ポリシー】
// - 画像本体（Base64）は保存しない
//   理由: メモリ消費が爆発する（数百KB×履歴件数）、プライバシー配慮、AgentCore Memory も同思想
// - 代わりに「画像の説明文」をユーザー発言に埋め込んだテキストとして保存
//   形式: "これ何？ [画像: ベージュ色の柴犬が公園で座っている写真]"
// - 画像の説明文は Gemma 3 が応答時に生成して image_description フィールドで返す
//
// 【AgentCore Memory への移行設計】
// AgentCore Memory の payload は role/content 構造なので、
// 本クラスのインターフェース（createEvent/listEvents）はそのまま使える。
// 本番では LocalMemoryStore を AgentCoreMemoryStore に差し替えるだけ。
//
// 【スキップしているもの】
// - 永続化（再起動でメモリ消える） → 本番では AgentCore が永続化担当
// - 長期メモリ検索 → 本番で AgentCore が自動抽出

'use strict';

const { randomUUID } = require('crypto');

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

// 直近何往復分をプロンプトに含めるか
// 多すぎるとトークン数が爆発、Lost in the middle 現象も
// 10 = 「直前の会話の流れ」を覚えるには十分
const MAX_SHORT_TERM_TURNS = 10;

// セッションのアイドルTTL
// 短すぎると離席時に「初めまして」状態になって不自然
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
  static create() {
    if (MODE === 'local') return new LocalMemoryStore();
    // 将来の AWS 実装：
    // return new AgentCoreMemoryStore({ memoryId: process.env.AGENTCORE_MEMORY_ID });
    throw new Error(`Unknown RAIM_MODE: ${MODE}`);
  }

  // ─── 抽象メソッド（サブクラスで実装する） ───

  async startSession({ actorId, sessionId }) { throw new Error('not implemented'); }
  async createEvent({ actorId, sessionId, payload }) { throw new Error('not implemented'); }
  async listEvents({ actorId, sessionId, maxResults }) { throw new Error('not implemented'); }

  /**
   * 長期メモリ検索（Step 1 ではスキップ、本番で AgentCore に任せる）
   */
  async retrieveMemoryRecords({ actorId, query, topK = 3 }) {
    return [];
  }
}

// ─────────────────────────────────────────────
// LocalMemoryStore: Map ベースのローカル実装
// ─────────────────────────────────────────────

class LocalMemoryStore extends MemoryStore {
  constructor() {
    super();
    // sessionId -> セッションデータ の Map
    this._sessions = new Map();

    // 5分ごとに期限切れセッションを削除
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 5 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * セッション開始
   * - sessionId が指定され、既に存在すれば再利用
   * - そうでなければ UUID で新規発行
   */
  async startSession({ actorId, sessionId }) {
    if (sessionId && this._sessions.has(sessionId)) {
      const session = this._sessions.get(sessionId);
      session.lastAccessedAt = Date.now();
      return { sessionId, isNew: false };
    }

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
   *
   * payload は [{role, content}, ...] の配列。content は以下の構造：
   *   { text: "..." }                                    ← テキストのみ
   *   { text: "これ何？ [画像: 柴犬が..." }              ← 画像説明を埋め込んだテキスト
   *
   * 画像本体（Base64）は保存しない、画像説明テキストとして埋め込まれた形のみ。
   */
  async createEvent({ actorId, sessionId, payload }) {
    let session = this._sessions.get(sessionId);

    if (!session) {
      await this.startSession({ actorId, sessionId });
      session = this._sessions.get(sessionId);
    }

    const timestamp = Date.now();
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
    if (session.actorId !== actorId) return [];

    session.lastAccessedAt = Date.now();

    return session.events.slice(-maxResults);
  }

  // ─── 内部ヘルパ ───

  _cleanupExpired() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions.entries()) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        this._sessions.delete(sessionId);
        console.log(`[MemoryStore] Session expired: ${sessionId}`);
      }
    }
  }

  _stats() {
    return {
      sessionCount: this._sessions.size,
      totalEvents: Array.from(this._sessions.values())
        .reduce((sum, s) => sum + s.events.length, 0),
    };
  }
}

// ─────────────────────────────────────────────
// 便利関数
// ─────────────────────────────────────────────

/**
 * MemoryStore のイベントを LLM の messages 配列に変換
 *
 * 変換ポイント:
 * - role を大文字 USER/ASSISTANT → 小文字 user/assistant に
 * - content.text を取り出して content フィールドに展開
 *
 * 注意: content.text には既に画像説明が埋め込まれている可能性がある
 *   例: "これ何？ [画像: ベージュ色の柴犬が公園で座っている写真]"
 * これは buildUserContentWithImage() でセットされる
 *
 * @param {Array<{role: string, content: Object}>} events
 * @returns {Array<{role: string, content: string}>}
 */
function eventsToMessages(events) {
  return events.map(event => ({
    role: event.role === Role.USER ? 'user' : 'assistant',
    content: event.content.text || '',
  }));
}

/**
 * ユーザー発言テキストと画像説明を結合して、履歴保存用の content を作る
 *
 * 例:
 *   userText = "これ何？"
 *   imageDescription = "ベージュ色の柴犬が公園で座っている写真"
 *   → "これ何？ [画像: ベージュ色の柴犬が公園で座っている写真]"
 *
 * 画像説明がない or 画像がない場合は userText をそのまま返す
 *
 * @param {string} userText
 * @param {string|null} imageDescription
 * @returns {string}
 */
function buildUserContentWithImage(userText, imageDescription) {
  if (!imageDescription) return userText || '';
  const cleanText = (userText || '').trim();
  if (cleanText.length === 0) {
    return `[画像: ${imageDescription}]`;
  }
  return `${cleanText} [画像: ${imageDescription}]`;
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  MemoryStore,
  LocalMemoryStore,
  Role,
  eventsToMessages,
  buildUserContentWithImage,
  MAX_SHORT_TERM_TURNS,
};