// lib/streaming-parser.js
// ==============================================================================
// JSON ストリームから text フィールドの値だけを順次抽出するパーサ
// ==============================================================================
//
// 【このファイルの役割】
// LLM が JSON 形式で順次出力するトークンストリームから、
// "text" フィールドの値部分だけをリアルタイムに取り出す。
//
// 【背景】
// Gemma は `{"type":"chat","text":"応答内容","emotion":"...","intensity":...}` の形で応答する。
// ストリーミング受信時、トークンは細切れに届く:
//   '{' '"type":' '"chat"' ',' '"text":' '"応' '答' '内' '容' '"' ',' '"emotion":' ...
//
// このパーサは、"text" フィールドの値（"応答内容"の中身）だけを抽出し、
// 句読点や改行で区切ったチャンクとして yield する。
//
// 【設計】
// シンプルな状態機械（ステートマシン）で実装:
//   - SEEK_TEXT_FIELD: "text" キーを探す
//   - SEEK_VALUE_START: "text" の値の開始（"）を探す
//   - IN_VALUE: 値の中身を蓄積、句読点で区切る
//   - DONE: "text" の値が閉じた（"）後、無視する
//
// 【補足】
// - JSON エスケープ（\"）に対応
// - 改行（\n）は区切りとして扱う
// - "image_description" フィールドは text とは別扱い、これも抽出する

'use strict';

// ─────────────────────────────────────────────
// 状態定義
// ─────────────────────────────────────────────

const STATE = Object.freeze({
  SEEK_TEXT_FIELD: 'seek_text_field',  // "text": を探す
  SEEK_VALUE_START: 'seek_value_start',// : の後の " を探す
  IN_VALUE: 'in_value',                // 値の中身を読み中
  DONE: 'done',                        // text 値の終わり、以降は image_description だけ拾う
});

// チャンク区切り文字（これらが来たらチャンクを yield する）
const BREAK_CHARS = /[。、！？\n]/;

// 句読点なしでも区切る最大文字数（フォールバック）
const MAX_CHUNK_LENGTH = 30;

// ─────────────────────────────────────────────
// StreamingTextExtractor クラス
// ─────────────────────────────────────────────

class StreamingTextExtractor {
  constructor() {
    this._state = STATE.SEEK_TEXT_FIELD;
    this._buffer = '';                 // 現在の状態の蓄積バッファ
    this._currentChunk = '';           // 出力待ちのチャンク
    this._escaped = false;             // 直前が \ だったか
    this._textFieldFound = false;      // 一度でも text フィールドを検出したか

    // image_description 抽出用（text 終了後に処理）
    this._imageDescription = '';
    this._extractingImageDescription = false;
    this._imageDescState = STATE.SEEK_TEXT_FIELD; // 簡易状態
  }

  /**
   * 新しいトークンを処理して、抽出できたチャンクを配列で返す
   *
   * @param {string} token 新着のトークン文字列
   * @returns {Array<string>} 抽出できたチャンクの配列（句読点や長さで区切られたもの）
   */
  feed(token) {
    const chunks = [];

    for (const ch of token) {
      // 状態に応じて処理
      if (this._state === STATE.SEEK_TEXT_FIELD) {
        // "text" というキーを探す
        // バッファに追加して、'"text":' が出現したかチェック
        this._buffer += ch;
        if (this._buffer.length > 20) {
          // バッファが大きくなりすぎたら古い部分を捨てる（メモリ節約）
          this._buffer = this._buffer.slice(-20);
        }
        if (this._buffer.includes('"text":') || this._buffer.includes('"text" :')) {
          this._state = STATE.SEEK_VALUE_START;
          this._buffer = '';
          this._textFieldFound = true;
        }
      } else if (this._state === STATE.SEEK_VALUE_START) {
        // : の後の最初の " を探す
        if (ch === '"') {
          this._state = STATE.IN_VALUE;
        }
        // 他の文字（空白等）は無視
      } else if (this._state === STATE.IN_VALUE) {
        // 値の中身を蓄積
        if (this._escaped) {
          // 直前が \ なら、エスケープシーケンス処理
          if (ch === 'n') {
            this._currentChunk += '\n';
          } else if (ch === '"') {
            this._currentChunk += '"';
          } else if (ch === '\\') {
            this._currentChunk += '\\';
          } else {
            this._currentChunk += ch;
          }
          this._escaped = false;
        } else if (ch === '\\') {
          this._escaped = true;
        } else if (ch === '"') {
          // 値の終わり
          if (this._currentChunk.length > 0) {
            chunks.push(this._currentChunk);
            this._currentChunk = '';
          }
          this._state = STATE.DONE;
        } else {
          this._currentChunk += ch;

          // 句読点 or 最大長で区切る
          if (BREAK_CHARS.test(ch) || this._currentChunk.length >= MAX_CHUNK_LENGTH) {
            chunks.push(this._currentChunk);
            this._currentChunk = '';
          }
        }
      } else if (this._state === STATE.DONE) {
        // text 値の後は image_description を拾う
        this._processImageDescription(ch);
      }
    }

    return chunks;
  }

  /**
   * 全トークン処理完了時に、残ったチャンクを取り出す
   * @returns {string|null} 残ったチャンク（あれば）
   */
  flush() {
    if (this._currentChunk.length > 0) {
      const chunk = this._currentChunk;
      this._currentChunk = '';
      return chunk;
    }
    return null;
  }

  /**
   * 抽出された image_description を返す（DONE 状態以降の処理）
   * @returns {string|null}
   */
  getImageDescription() {
    return this._imageDescription.length > 0 ? this._imageDescription : null;
  }

  /**
   * text フィールドが見つかったか
   */
  hasTextField() {
    return this._textFieldFound;
  }

  // ─── 内部: image_description 抽出（簡易版） ───
  _processImageDescription(ch) {
    // 簡易実装：DONE 状態に入った後、"image_description":"..." パターンを拾う
    if (!this._extractingImageDescription) {
      this._buffer += ch;
      if (this._buffer.length > 30) this._buffer = this._buffer.slice(-30);

      if (this._buffer.includes('"image_description":')) {
        this._extractingImageDescription = true;
        this._buffer = '';
        this._imageDescState = STATE.SEEK_VALUE_START;
      }
    } else if (this._imageDescState === STATE.SEEK_VALUE_START) {
      if (ch === '"') {
        this._imageDescState = STATE.IN_VALUE;
      }
    } else if (this._imageDescState === STATE.IN_VALUE) {
      if (this._escaped) {
        if (ch === 'n') this._imageDescription += '\n';
        else if (ch === '"') this._imageDescription += '"';
        else if (ch === '\\') this._imageDescription += '\\';
        else this._imageDescription += ch;
        this._escaped = false;
      } else if (ch === '\\') {
        this._escaped = true;
      } else if (ch === '"') {
        // image_description の値の終わり
        this._imageDescState = 'done';
      } else {
        this._imageDescription += ch;
      }
    }
  }
}

module.exports = {
  StreamingTextExtractor,
  STATE,
  BREAK_CHARS,
  MAX_CHUNK_LENGTH,
};