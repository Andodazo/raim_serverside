// server.js
// ==============================================================================
// RAiM 中継サーバー：マルチモーダル対応版
// ==============================================================================
//
// 【このファイルの役割】
// Flutter からの WebSocket 接続を受け、テキスト+画像の入力を処理して
// シーン判定 → 履歴取得 → プロンプト組立 → LLM 推論 → 応答返却 を統括する。
//
// 【マルチモーダル対応の変更点】
// - Flutter から { text, images: [{data, media_type}], session_id } を受信
// - images.data（Base64）を抽出して pickScene と buildMessages に渡す
// - 応答 JSON の image_description（内部用）を履歴記録時に活用
// - Flutter には image_description を送らない（types.js の normalizeLLMOutput で除去）
// - ログに images=N / hasImage=true を出力
//
// 【処理フロー】
//   [Flutter] ─ ws.send({text, images, session_id}) ──→ [server.js]
//                                                          │
//                                                          ├ images の Base64 を取り出し
//                                                          │
//                                                          ├ pickScene(text, {images})
//                                                          │   → hasImage バイアス補正でシーン判定
//                                                          │
//                                                          ├ memoryStore.listEvents() ← 並列
//                                                          │
//                                                          ├ buildMessages(scene, text, history, imageData)
//                                                          │   → Ollama 形式の images 添付
//                                                          │
//                                                          ├ callLLM(messages) ← Gemma 3 マルチモーダル推論
//                                                          │   → JSON 応答（image_description 含む）
//                                                          │
//                                                          ├ normalizeLLMOutput で image_description 抽出
//                                                          │
//                                                          ├ memoryStore.createEvent()
//                                                          │   ユーザー発言に [画像: 説明文] を埋め込んで記録
//                                                          │
//                                                          └ chat メッセージを Flutter へ送信（image_description 除く）

// ==============================================================================
// RAiM 中継サーバー：ストリーミング応答対応版
// ==============================================================================
//
// 【v5 での変更点】
// - 応答を 3 段階で送信:
//   1. metadata (即時、emotion / intensity 先送り) → Unity 表情切替・TTS準備
//   2. text_chunk (LLM 推論進行中、句読点ごと) → UI 表示・TTS 順次合成
//   3. chat_end (LLM 推論完了) → TTS キュー完了
// - LLM はストリーミング呼出 (callLLMStream) を使用
// - StreamingTextExtractor で text フィールドの値だけ抽出
//
// 【ユーザー体験の改善】
// 旧: ユーザー送信 → 5〜10秒待ち → 全文一括表示・音声再生
// 新: ユーザー送信 → 即時 emotion 反映 → 1〜2秒で喋り始め → 順次表示・音声
//
// 【v6 での変更点】
// - RAIM_STREAMING 環境変数でストリーミング ON/OFF を切替可能に
//   - true (デフォルト): ストリーミング応答 (metadata + text_chunk + chat_end)
//   - false: 従来の一括 chat 応答（旧クライアント互換）
// - 旧クライアントでテストしたい時は .env で RAIM_STREAMING=false にする
//
// 【処理の分岐ポイント】
// ストリーミング ON  → handleStreaming() で 3 段階送信
// ストリーミング OFF → handleNonStreaming() で chat メッセージ 1 個送信

// 【v7 での変更点】
// - 起動ログとリクエストログに現在時刻を表示
// - 動作中の「ライムがどの時間帯として認識してるか」をログで追える
// - 機能的な変更は prompt-builder.js に集約、server.js は表示のみ
//
// 【既存のストリーミング切替機能は維持】
// RAIM_STREAMING=true (デフォルト): 3段階送信
// RAIM_STREAMING=false: 従来の chat 一括応答

// 【v9 での変更点】
// - VOICEVOX 呼出をサーバー側で実施（旧: Flutter が直接叩いていた）
// - text_chunk と並行して audio_chunk（Base64 WAV）を送信
// - chunk_id で text と audio を紐付け
// - サーバー起動時に VOICEVOX 接続確認
//
// 【処理フロー】
//   metadata 即送信
//      ↓
//   LLM ストリーミング推論開始
//      ↓ トークン到着
//   StreamingTextExtractor で text を句単位抽出
//      ↓ 句完成
//   ├─ text_chunk JSON 送信（UI 表示用）
//   └─ VOICEVOX 非同期合成 → audio_chunk JSON 送信（再生用）
//      ↓ LLM 完了
//   chat_end 送信、履歴記録
//
// 【設計上のポイント】
// VOICEVOX 合成は非同期で並列実行する。
// 順序保証: chunk_id でクライアント側がペアリング
// テキストは即送り、音声は合成完了次第追っかけで送る形

// ==============================================================================
// RAiM 中継サーバー：C-1 Function Calling 統合版
// ==============================================================================
//
// 【v10 での変更点】
// - LLM 1回目を tools 付き呼出に変更（callLLMWithTools）
// - tool_calls 検出時：
//   1. 固定セリフ（pickToolIntro）を text_chunk + audio_chunk で送信
//   2. tool_call メッセージ送信（Flutter UI表示用）
//   3. ツール実行
//   4. tool 結果を messages に追加して次のターンへ
// - 最大3ターンまで連続実行、4ターン目は強制的にツールなし
// - ツールが返らない（通常応答）場合は既存のストリーミングフロー
//
// 【既存機能は全て維持】
// - ストリーミング応答（A-3）
// - マルチモーダル（画像入力）
// - 時刻認識（B-1）
// - 声プロファイル（B-2、サーバー内部）
// - TTS サーバー集約（D-2）
//
// 【v11 での修正点】
// - MAX_TOOL_TURNS を 3 → 2 に削減
// - 同じツール+引数の連続呼出を検知して強制終了
// - 最終応答強制プロンプトを強化（「ツール結果を活用して答える」を明示）
// - ツール失敗を検知してプロンプト分岐

// 【v12 での変更点】
// - filler_audio メッセージを廃止（text_chunk + is_filler:true で代替）
// - emotions オブジェクト形式に対応（複数感情）
// - emotion + intensity は後方互換用に維持（types.js が自動算出）
// - シーンの default_emotion → default_emotions （後方互換あり）
//
// 【既存機能は維持】
// - A-3 ストリーミング応答
// - D-2 TTS サーバー集約
// - B-1 時刻認識
// - C-1 Function Calling
// - マルチモーダル

// 【v13 での変更点】
// - 感情キーを 12種類に拡張（curious, amused, thoughtful, playful 追加）
// - emotions を合計1.0 に正規化、overall_intensity を別途算出
// - voice-mapper への入力を emotions + overall_intensity に統一
// - シーン default_emotions も新感情を活用可能に
// server.js
// ==============================================================================
// RAiM 中継サーバー：v14（filler 廃止 + audio 順序保証 + bubble_break 対応版）
// ==============================================================================
//
// 【v14 での変更点】
// 1. needsHeavyProcessing の filler 廃止
//    → ツール使用時は tool intro で「調べるね」と言えば十分、二重発話を防ぐ
//    → ツール不要のヘビー処理（画像認識のみ等）でも、metadata で emotion 先送りしてるので
//      ユーザー体感上「待たされてる感」は既に緩和されている
//
// 2. audio_chunk の順序保証
//    → 並列 TTS 合成は維持（速度のため）
//    → 送信は Promise.all + 順次 await で chunk_id 順を保証
//    → Flutter 側の AudioPlayQueue が届いた順に再生するため、送信順=再生順にする
//
// 3. tool intro 後に bubble_break 送信
//    → Flutter は bubble_break を受けたら _currentStreamingMessage をリセット
//    → 次の text_chunk（本文）は別の吹き出しとして表示される
//    → intro と本文が同じ吹き出しに繋がる問題を解消
// server.js
// ==============================================================================
// RAiM 中継サーバー：v14_fix2（LLM 誤動作対策強化版）
// ==============================================================================
//
// 【v14_fix2 での変更点】
// C. 類似クエリの重複検知
//    - query の頭15文字だけで判定（「二郎系ラーメン お」で始まる query は重複扱い）
//    - 無駄な再検索を防ぐ
//
// E. 空応答フォールバック
//    - LLM が空文字を返した時、ライムらしいエラーメッセージ表示
//    - text_len=0 のまま chat_end 送るのを防ぐ
//
// F. 強制応答プロンプトの簡潔化
//    - 長い指示は Gemma が混乱する
//    - 「検索結果を踏まえて答えて。tools 使わないで。」に絞る
//
// 【v14 からの継承】
// - bubble_break 対応
// - filler 廃止
// - audio_chunk 順序保証
// - 12感情 + 正規化
// 【v16 での変更点】
// 1. チャンク送信ごとにタイミングログを出す
//    "[~] chunk +XXXms" が数百 ms 間隔で並べば真のストリーミング、
//    全部同じ ms なら Ollama 側でバッファされている（＝一括送信と同じ）。
//    切り分け用なので、確認が済んだら STREAM_TIMING_LOG=false で黙らせられる。
//
// 2. ツール実行後は tools を渡さない（MULTI_TURN_TOOLS=false が既定）
//    v15 までは Turn 2 も tools 付きで呼んでいたため、Gemma 4 12B が
//    同じツールを呼び直したり "tool_result" を捏造したりして 1 ターン無駄になり、
//    LLM 呼び出しが 3 回（合計 36 秒）になっていた。
//    ツール結果が messages に入った時点で tools を外し、
//    callLLMStream（tools なし・format:'json'）で本文だけ生成する。
//    → LLM 2 回で済み、ツール名の捏造も構造的に起きなくなる。
//    多段ツール連鎖（天気を見てから検索、等）が必要になったら
//    MULTI_TURN_TOOLS=true で v15 の挙動に戻せる。
//
// 【v15 / v15_fix からの継承】
// - callLLMStreamWithTools による token 単位の真のストリーミング
// - 未知ツール名を intro 送信前にフィルタ
// - bubble_break（tool intro と本文の吹き出し分離）
// - audio_chunk の送信順を chunk_id 順に直列化（合成は並列）
// - 類似クエリの重複検知 / 空応答フォールバック / 12感情 + 正規化
//
//
// 【v15 での変更点 — 本命】
// ツール判断と本文生成を 1 パスに統合し、token 単位の真のストリーミングにした。
//
//   v14_fix2 まで:
//     callLLMWithTools (stream:false) で全文生成
//       → splitIntoChunks で機械的に分割
//       → for ループで一気に ws.send
//     → Flutter には数 ms 以内に全 chunk が到着し、体感は「一瞬で全文表示」
//
//   v15:
//     callLLMStreamWithTools (stream:true) で token を受信
//       → StreamingTextExtractor が JSON の text 値だけを増分抽出
//       → 抽出できた瞬間に text_chunk 送信 + TTS 合成開始
//     → 実測でチャンク間隔 140〜270ms、typewriter 表示になる
//
// 【なぜ 1 パスにしたか】
// ツール判断を stream:false で別途行うと、ツール不要の通常応答（最も多く、
// 最もストリーミングを見せたいケース）で全文生成が二重になり、体感が倍遅くなる。
// Ollama 0.32.1 で Gemma 4 の tool calling が改善されたため、
// tools 付き streaming を 1 パスで回す構成が現実的になった。
//
// 【text と tool_calls が両方来た場合】
// Gemma 4 は tool_calls を返すとき content が空になる傾向があり、通常は
// どちらか一方しか来ない。万一 text を送った後に tool_calls が来た場合は
// 警告ログを出し、送信済みテキストは intro 扱い（bubble_break で本文と分離）にする。
//
// 【audio_chunk の順序保証】
// TTS は chunk が確定した瞬間に並列で合成を開始するが、送信は Promise チェーンで
// 直列化する。合成は並列（速い）、送信順は chunk_id 順（音声が本文通りに流れる）。
//
// 【v14 / v14_fix / v14_fix2 からの継承】
// - bubble_break（tool intro と本文の吹き出し分離）
// - needsHeavyProcessing 由来の filler 廃止
// - unknown tool を throw せず error result で返す（lib/tools/index.js 側）
// - 類似クエリの重複検知（query 先頭15文字）
// - 空応答フォールバック
// - 12感情 + 正規化 + overall_intensity

require('dotenv').config();
const { WebSocketServer } = require('ws');
const {
  callLLM,
  callLLMStream,
  callLLMWithTools,
  callLLMStreamWithTools,
} = require('./lib/llm');
const { buildMessages, getTimeContext } = require('./lib/prompt-builder');
const { pickScene } = require('./lib/pick-scene');
const { StreamingTextExtractor } = require('./lib/streaming-parser');
const {
  MemoryStore,
  Role,
  eventsToMessages,
  buildUserContentWithImage,
} = require('./lib/memory-store');
const {
  loadVoiceConfig,
  getVoiceParamsFromEmotions,
  getActiveProfileInfo,
} = require('./lib/voice-mapper');
const {
  synthesize,
  wavToBase64,
  checkVoicevoxAvailable,
} = require('./lib/tts');
const {
  TOOL_DEFINITIONS,
  executeTool,
  pickToolIntro,
  getToolDescription,
  isValidToolName,
} = require('./lib/tools');
const {
  ALL_EMOTIONS,
  ERROR_CODES,
  createError,
  createSessionStart,
  createMetadata,
  createTextChunk,
  createAudioChunk,
  createChatEnd,
  createToolCall,
  createBubbleBreak,
  validateUpstream,
  sanitizeEmotions,
  emotionToEmotions,
  resolveEmotionsInput,
} = require('./lib/types');

const PORT = 8080;
const memoryStore = MemoryStore.create();
const DEFAULT_ACTOR_ID = 'default_user';
const MAX_TOOL_TURNS = 2;

// ストリーミングを無効にすると v14_fix2 相当の一括生成にフォールバックする
const STREAMING_ENABLED = process.env.RAIM_STREAMING !== 'false';

// チャンク送信ごとのタイミングログ（ストリーミング検証用、既定 ON）
const STREAM_TIMING_LOG = process.env.STREAM_TIMING_LOG !== 'false';

// ツール実行後も tools を渡し続けるか（既定 OFF）
// OFF: ツール結果が入ったら tools を外し、本文生成だけを streaming で行う
// ON : v15 の挙動。多段ツール連鎖ができるが、12B では空回りしやすい
const MULTI_TURN_TOOLS = process.env.MULTI_TURN_TOOLS === 'true';

loadVoiceConfig();

// ─────────────────────────────────────────────
// 小物ユーティリティ
// ─────────────────────────────────────────────

function makeChunkIdGenerator(sessionId) {
  let counter = 0;
  return () => `${sessionId}_chunk_${counter++}`;
}

/** query の先頭15文字だけで重複判定する（類似クエリの再検索を防ぐ） */
function normalizeQueryForKey(args) {
  if (args.query) return args.query.trim().slice(0, 15);
  if (args.city) return args.city.trim().toLowerCase();
  return JSON.stringify(args);
}

function makeToolCallKey(toolName, args) {
  return `${toolName}:${normalizeQueryForKey(args)}`;
}

function getSceneDefaultEmotions(picked) {
  if (picked.defaultEmotions) return picked.defaultEmotions;
  return emotionToEmotions(picked.defaultEmotion, picked.defaultIntensity);
}

function parseToolArgs(raw) {
  if (typeof raw !== 'string') return raw || {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`  [Tool] Failed to parse arguments: ${raw}`);
    return {};
  }
}

function stripJsonFence(text) {
  return (text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * チャンク送信のタイミングを記録する（ストリーミング検証用）
 *
 * 出力例:
 *   [~] chunk +8200ms (Δ0ms) "えっと、"
 *   [~] chunk +8450ms (Δ250ms) "今のところ東京は厚い雲がかかってるみたいだよ。"
 *
 * Δ が数百 ms 空いていれば真のストリーミング。
 * Δ が全部 0〜数 ms なら Ollama 側でバッファされており、
 * 体感は一括送信と変わらない。
 */
function createChunkTimer(label) {
  const startedAt = Date.now();
  let lastAt = null;
  let count = 0;

  return {
    mark(text) {
      if (!STREAM_TIMING_LOG) return;
      const now = Date.now();
      const elapsed = now - startedAt;
      const delta = lastAt === null ? 0 : now - lastAt;
      lastAt = now;
      count++;
      console.log(`  [~] ${label} chunk#${count} +${elapsed}ms (Δ${delta}ms) "${text}"`);
    },
    summary() {
      if (!STREAM_TIMING_LOG || count === 0) return;
      console.log(`  [~] ${label}: ${count} chunks over ${Date.now() - startedAt}ms`);
    },
  };
}

/**
 * StreamingTextExtractor の戻り値を string[] に正規化する
 *   feed(token) => string[]（該当なしは []）
 *   flush()     => string | null
 */
function normalizeToChunks(result) {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') return result.length > 0 ? [result] : [];
  return [];
}

// ─────────────────────────────────────────────
// 音声送信キュー（合成は並列、送信は直列）
// ─────────────────────────────────────────────

/**
 * TTS 合成を即座に開始しつつ、audio_chunk の送信順を enqueue 順に保つ。
 *
 * synthesize() は呼んだ瞬間に走り出すので合成自体は並列。
 * 送信だけを Promise チェーンで直列化することで、
 * 短い chunk が先に合成完了しても送信順は崩れない。
 */
function createAudioSender(ws, ttsEnabled) {
  let chain = Promise.resolve();
  let count = 0;

  return {
    enqueue(chunkId, text, voiceParams) {
      if (!ttsEnabled || !voiceParams) return;
      count++;

      const ttsPromise = synthesize(text, voiceParams)
        .then((wavBuffer) => ({ wavBuffer, error: null }))
        .catch((error) => ({ wavBuffer: null, error }));

      chain = chain.then(async () => {
        const { wavBuffer, error } = await ttsPromise;
        if (error) {
          console.warn(`[!] TTS error for ${chunkId}: ${error.message}`);
          return;
        }
        if (!wavBuffer) return;
        try {
          ws.send(JSON.stringify(createAudioChunk({
            chunkId,
            audioBase64: wavToBase64(wavBuffer),
            format: 'wav',
          })));
          console.log(
            `[♪] audio_chunk sent: id=${chunkId}, ` +
            `text_len=${text.length}, wav_size=${Math.floor(wavBuffer.length / 1024)}KB`
          );
        } catch (e) {
          console.warn(`[!] audio_chunk send failed for ${chunkId}: ${e.message}`);
        }
      });
    },

    /** 全 audio_chunk の送信完了を待つ（上限つき） */
    async drain(timeoutMs = 20000) {
      if (count === 0) return;
      await Promise.race([
        chain,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}

// ─────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────

async function main() {
  const voicevoxOk = await checkVoicevoxAvailable();

  const wss = new WebSocketServer({ port: PORT });
  console.log(`\u2713 RAiM local server listening on ws://127.0.0.1:${PORT}`);
  console.log(`  Streaming mode: ${STREAMING_ENABLED ? 'ON (true token streaming, v15)' : 'OFF (batched fallback)'}`);
  console.log(`  TTS mode: ${voicevoxOk ? 'ON (server-side VOICEVOX)' : 'OFF (text only)'}`);
  console.log(`  ${getTimeContext()}`);
  const profileInfo = getActiveProfileInfo();
  if (profileInfo) {
    console.log(`  Voice profile: ${profileInfo.name} (${profileInfo.speaker_name})`);
  }
  console.log(`  Tools: ${TOOL_DEFINITIONS.map(t => t.function.name).join(', ')}`);
  console.log(`  Max tool turns: ${MAX_TOOL_TURNS}`);
  console.log(`  Emotions: ${ALL_EMOTIONS.length} types (normalized + overall_intensity)`);
  console.log(`  Multi-turn tools: ${MULTI_TURN_TOOLS ? 'ON' : 'OFF (tools dropped after execution)'}`);
  console.log(`  Chunk timing log: ${STREAM_TIMING_LOG ? 'ON' : 'OFF'}`);
  console.log(`  Protocol: v16 (bubble_break, ordered audio, token streaming)`);

  if (!process.env.TAVILY_API_KEY) {
    console.warn('  ⚠ TAVILY_API_KEY not set, web_search will fail');
  }
  if (!process.env.OPENWEATHERMAP_API_KEY) {
    console.warn('  ⚠ OPENWEATHERMAP_API_KEY not set, get_weather will fail');
  }

  wss.on('connection', async (ws) => {
    console.log('[+] Client connected');

    const connectionContext = {
      actorId: DEFAULT_ACTOR_ID,
      sessionId: null,
      ttsEnabled: voicevoxOk,
    };

    const { sessionId } = await memoryStore.startSession({
      actorId: connectionContext.actorId,
      sessionId: null,
    });
    connectionContext.sessionId = sessionId;

    ws.send(JSON.stringify(createSessionStart({ sessionId })));
    console.log(`[~] Session started: ${sessionId}`);

    ws.on('message', async (rawData) => {
      let parsed;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        ws.send(JSON.stringify(createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'JSON形式が不正です',
          retriable: false,
        })));
        return;
      }

      const validation = validateUpstream(parsed);
      if (!validation.valid) {
        ws.send(JSON.stringify(createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: validation.error,
          retriable: false,
        })));
        return;
      }

      const sessionId = parsed.session_id || connectionContext.sessionId;
      const actorId = connectionContext.actorId;
      const userMessage = validation.message.text;
      const imageObjects = parsed.images || [];
      const imageBase64Array = imageObjects.map(img => img.data);
      const hasImage = imageBase64Array.length > 0;

      console.log(
        `[<] User: ${userMessage} (session=${sessionId}` +
        `${hasImage ? `, images=${imageBase64Array.length}` : ''}) [${getTimeContext()}]`
      );

      try {
        const t0 = Date.now();

        const [picked, pastEvents] = await Promise.all([
          pickScene(userMessage, { images: imageBase64Array }),
          memoryStore.listEvents({ actorId, sessionId }),
        ]);
        const t1 = Date.now();

        const history = eventsToMessages(pastEvents);
        console.log(
          `[?] Scene: ${picked.scene.id} ` +
          `(score=${picked.score.toFixed(3)}, ${t1 - t0}ms, ` +
          `history=${history.length} turns, hasImage=${hasImage})`
        );

        await handleRequest(ws, picked, userMessage, hasImage, imageBase64Array, history, {
          actorId, sessionId, t0,
          ttsEnabled: connectionContext.ttsEnabled,
        });
      } catch (err) {
        console.error('[!] Error:', err.message);
        console.error(err.stack);

        let code = ERROR_CODES.INTERNAL_ERROR;
        if (err.message.includes('LLM') || err.message.includes('Ollama')) {
          code = ERROR_CODES.LLM_ERROR;
        } else if (err.message.includes('embed')) {
          code = ERROR_CODES.EMBED_ERROR;
        } else if (err.message.includes('VOICEVOX') || err.message.includes('TTS')) {
          code = ERROR_CODES.TTS_ERROR;
        }

        ws.send(JSON.stringify(createError({
          code,
          message: 'えっと……ごめん、ちょっと調子悪いみたい。',
          retriable: true,
        })));
      }
    });

    ws.on('close', () => {
      console.log(`[-] Client disconnected (session=${connectionContext.sessionId})`);
    });
  });
}

// ─────────────────────────────────────────────
// メイン処理
// ─────────────────────────────────────────────

async function handleRequest(ws, picked, userMessage, hasImage, imageBase64Array, history, ctx) {
  const { actorId, sessionId, t0, ttsEnabled } = ctx;
  const nextChunkId = makeChunkIdGenerator(sessionId);
  const audioSender = createAudioSender(ws, ttsEnabled);

  const rawDefaultEmotions = getSceneDefaultEmotions(picked);
  const metaResolved = resolveEmotionsInput({ emotions: rawDefaultEmotions });

  ws.send(JSON.stringify(createMetadata({
    emotions: rawDefaultEmotions,
    sceneId: picked.scene.id,
  })));
  console.log(
    `[>] Metadata sent: emotions=${JSON.stringify(metaResolved.emotions)}, ` +
    `overall=${metaResolved.overall_intensity}, dominant=${metaResolved.emotion}`
  );

  // 本文の音声パラメータはシーンの default_emotions ベースで固定する。
  // 実際の emotions は JSON パース完了後（＝本文送信後）にしか分からないため、
  // ストリーミング中は先に確定しているシーン既定値を使う。
  const bodyVoiceParams = ttsEnabled
    ? getVoiceParamsFromEmotions(metaResolved.emotions, metaResolved.overall_intensity)
    : null;
  // intro / filler は少し控えめの強度で喋らせる
  const introVoiceParams = ttsEnabled
    ? getVoiceParamsFromEmotions(metaResolved.emotions, 0.6)
    : null;

  const messages = buildMessages(
    picked.scene,
    userMessage,
    history,
    imageBase64Array,
    { withTools: true }
  );

  const state = {
    finalText: '',
    finalRawEmotions: rawDefaultEmotions,
    imageDescription: null,
    hasSentIntro: false,
    hasStreamedBody: false,
    toolError: false,
    exitedDueToDuplicate: false,
    hallucinatedTool: false,
    toolsExecuted: false,
    seenToolCalls: new Set(),
    toolTurn: 0,
  };

  if (STREAMING_ENABLED) {
    await runStreamingToolLoop(ws, messages, state, {
      nextChunkId, audioSender, bodyVoiceParams, introVoiceParams, ttsEnabled,
    });
  } else {
    await runBatchedToolLoop(ws, messages, state, {
      nextChunkId, audioSender, bodyVoiceParams, introVoiceParams, ttsEnabled,
    });
  }

  // ── 本文が取れなかった場合の強制応答 ────────────────
  if (state.finalText === '' && !state.hasStreamedBody) {
    await forceFinalResponse(ws, messages, state, {
      nextChunkId, audioSender, bodyVoiceParams, ttsEnabled,
    });
  }

  // ── 空応答フォールバック ────────────────────────
  if (!state.finalText || state.finalText.trim() === '') {
    console.warn('  [!] Empty final response, using fallback message');
    state.finalText = 'えっと……調べてはみたんだけど、うまく言葉にまとまらなかった。ごめん、もう一回聞いてくれる？';
    state.finalRawEmotions = { embarrassed: 0.5, sad: 0.3 };

    // フォールバック文はまだ送っていないので、ここで送る
    if (!state.hasStreamedBody) {
      if (state.hasSentIntro) {
        ws.send(JSON.stringify(createBubbleBreak()));
        console.log('  [>] bubble_break sent (before fallback body)');
      }
      await sendTextAsChunks(ws, state.finalText, {
        nextChunkId, audioSender, voiceParams: bodyVoiceParams,
        isFirst: !state.hasSentIntro,
      });
      state.hasStreamedBody = true;
    }
  }

  // ── 全 audio_chunk の送信完了を待つ ──────────────
  await audioSender.drain();

  // ── chat_end ────────────────────────────────
  const finalResolved = resolveEmotionsInput({ emotions: state.finalRawEmotions });
  ws.send(JSON.stringify(createChatEnd({
    fullText: state.finalText,
    emotions: state.finalRawEmotions,
  })));

  const t2 = Date.now();
  console.log(
    `[>] chat_end: emotions=${JSON.stringify(finalResolved.emotions)}, ` +
    `overall=${finalResolved.overall_intensity}, dominant=${finalResolved.emotion}, ` +
    `text_len=${state.finalText.length}, toolTurns=${state.seenToolCalls.size}, ` +
    `total=${t2 - t0}ms`
  );

  // ── 履歴記録 ────────────────────────────────
  const userContent = buildUserContentWithImage(userMessage, state.imageDescription);
  await memoryStore.createEvent({
    actorId,
    sessionId,
    payload: [
      { role: Role.USER, content: { text: userContent } },
      { role: Role.ASSISTANT, content: { text: state.finalText } },
    ],
  });

  if (state.imageDescription) {
    console.log(`[+] Image described: "${state.imageDescription.slice(0, 60)}..."`);
  }
}

// ─────────────────────────────────────────────
// v15 本命: ストリーミング版ツールループ
// ─────────────────────────────────────────────

async function runStreamingToolLoop(ws, messages, state, io) {
  const { nextChunkId, audioSender, bodyVoiceParams, introVoiceParams, ttsEnabled } = io;

  while (state.toolTurn < MAX_TOOL_TURNS) {
    state.toolTurn++;
    console.log(`[Tool Loop] Turn ${state.toolTurn}/${MAX_TOOL_TURNS} (streaming)`);

    const extractor = new StreamingTextExtractor();
    const timer = createChunkTimer(`turn${state.toolTurn}`);
    let rawContent = '';
    let thinking = '';
    let toolCalls = null;
    let sentChunkThisTurn = false;
    let firstChunkAt = null;
    const turnStartedAt = Date.now();

    // ── LLM ストリーム受信 ────────────────────
    for await (const ev of callLLMStreamWithTools(messages, TOOL_DEFINITIONS)) {
      if (ev.type === 'thinking') {
        thinking += ev.content;
        continue;
      }

      if (ev.type === 'tool_calls') {
        toolCalls = ev.tool_calls;
        continue;
      }

      if (ev.type === 'token') {
        rawContent += ev.content;

        const chunks = normalizeToChunks(extractor.feed(ev.content));
        for (const chunk of chunks) {
          // 本文の最初のチャンクを出す直前に、intro との吹き出しを分ける
          if (!sentChunkThisTurn && state.hasSentIntro && !state.hasStreamedBody) {
            ws.send(JSON.stringify(createBubbleBreak()));
            console.log('  [>] bubble_break sent (intro → body)');
          }

          const chunkId = nextChunkId();
          ws.send(JSON.stringify(createTextChunk({
            text: chunk,
            chunkId,
            isFirst: !state.hasSentIntro && !state.hasStreamedBody && !sentChunkThisTurn,
          })));
          audioSender.enqueue(chunkId, chunk, bodyVoiceParams);
          timer.mark(chunk);

          if (firstChunkAt === null) {
            firstChunkAt = Date.now();
            console.log(`  [~] first body chunk at +${firstChunkAt - turnStartedAt}ms`);
          }
          sentChunkThisTurn = true;
          state.hasStreamedBody = true;
        }
      }
    }

    if (thinking) {
      console.log(`  [Thinking] ${thinking.slice(0, 200).replace(/\n/g, ' ')}...`);
    }

    // ── ツール呼出あり ──────────────────────
    if (toolCalls && toolCalls.length > 0) {
      if (sentChunkThisTurn) {
        // 想定外だが致命ではない。送信済みテキストは intro 扱いにする
        console.warn('  [!] tool_calls arrived after body text was streamed. Treating sent text as intro.');
        state.hasSentIntro = true;
        state.hasStreamedBody = false;
      }

      const shouldBreak = await handleToolCalls(ws, messages, toolCalls, state, {
        nextChunkId, audioSender, introVoiceParams, ttsEnabled,
      });
      if (shouldBreak) break;

      // v16: ツールを実行したら tools を外して本文生成に移る。
      // Gemma 4 12B は tool 結果を渡されても同じツールを呼び直したり
      // 架空のツール名を返したりして 1 ターン空回りしやすいため、
      // ツールを呼びようがない状態（tools なし）で本文だけ生成させる。
      if (!MULTI_TURN_TOOLS) {
        state.toolsExecuted = true;
        break;
      }
      continue;
    }

    // ── ツールなし = 本文が流れ切った ──────────
    console.log(`  [No tool] streamed body (${rawContent.length} chars raw)`);
    // flush で残りを吐き出す
    const remaining = normalizeToChunks(extractor.flush());
    for (const chunk of remaining) {
      const chunkId = nextChunkId();
      ws.send(JSON.stringify(createTextChunk({ text: chunk, chunkId })));
      audioSender.enqueue(chunkId, chunk, bodyVoiceParams);
      timer.mark(chunk);
      state.hasStreamedBody = true;
    }
    timer.summary();

    // 完成した JSON から text / emotions / image_description を回収
    applyParsedContent(rawContent, state, extractor);
    break;
  }
}

// ─────────────────────────────────────────────
// フォールバック: 一括生成版ツールループ（RAIM_STREAMING=false 用）
// ─────────────────────────────────────────────

async function runBatchedToolLoop(ws, messages, state, io) {
  const { nextChunkId, audioSender, bodyVoiceParams, introVoiceParams, ttsEnabled } = io;

  while (state.toolTurn < MAX_TOOL_TURNS) {
    state.toolTurn++;
    console.log(`[Tool Loop] Turn ${state.toolTurn}/${MAX_TOOL_TURNS} (batched)`);

    const llmResult = await callLLMWithTools(messages, TOOL_DEFINITIONS);

    if (llmResult.thinking) {
      console.log(`  [Thinking] ${llmResult.thinking.slice(0, 200).replace(/\n/g, ' ')}...`);
    }

    if (llmResult.tool_calls && llmResult.tool_calls.length > 0) {
      const shouldBreak = await handleToolCalls(ws, messages, llmResult.tool_calls, state, {
        nextChunkId, audioSender, introVoiceParams, ttsEnabled,
      });
      if (shouldBreak) break;
      continue;
    }

    console.log('  [No tool] LLM returned normal response');
    applyParsedContent(llmResult.content || '', state, null);

    if (state.finalText) {
      if (state.hasSentIntro) {
        ws.send(JSON.stringify(createBubbleBreak()));
        console.log('  [>] bubble_break sent (intro → body)');
      }
      await sendTextAsChunks(ws, state.finalText, {
        nextChunkId, audioSender, voiceParams: bodyVoiceParams,
        isFirst: !state.hasSentIntro,
      });
      state.hasStreamedBody = true;
    }
    break;
  }
}

// ─────────────────────────────────────────────
// ツール呼出の処理（ストリーミング/一括で共通）
// ─────────────────────────────────────────────

/**
 * @returns {boolean} true なら重複検知でループを抜ける
 */
async function handleToolCalls(ws, messages, toolCalls, state, io) {
  const { nextChunkId, audioSender, introVoiceParams } = io;

  console.log(`  [Tool Calls] ${toolCalls.length} tool(s) requested`);

  // ── 未知ツール名を intro 送信前に弾く（v15_fix） ──────────────
  // Gemma 4 は tool 結果を受け取った後、"tool_result" のような存在しない
  // ツール名を呼ぶことがある。executeTool 側でも error result を返して
  // サーバーは落ちないようにしてあるが、そこまで進むと
  // 無駄な intro（「えっと、ちょっと待って」）と tool_call バナーが
  // クライアントに飛んでしまう。ここで先に落とす。
  const validToolCalls = toolCalls.filter((tc) => {
    const name = tc.function && tc.function.name;
    if (isValidToolName(name)) return true;
    console.warn(`  [!] Hallucinated tool name ignored: "${name}"`);
    return false;
  });

  if (validToolCalls.length === 0) {
    state.hallucinatedTool = true;
    return true;  // ループを抜けて強制応答へ
  }

  // 重複・類似クエリの検知
  for (const toolCall of validToolCalls) {
    const toolName = toolCall.function.name;
    const toolArgs = parseToolArgs(toolCall.function.arguments);
    const key = makeToolCallKey(toolName, toolArgs);
    if (state.seenToolCalls.has(key)) {
      console.warn(`  [!] Duplicate/similar tool call detected: ${key}`);
      state.exitedDueToDuplicate = true;
      return true;
    }
  }

  for (const toolCall of validToolCalls) {
    const toolName = toolCall.function.name;
    const toolArgs = parseToolArgs(toolCall.function.arguments);

    state.seenToolCalls.add(makeToolCallKey(toolName, toolArgs));

    // 前置きセリフ（「調べるね」）
    const introText = pickToolIntro(toolName, state.toolTurn);
    const introChunkId = nextChunkId();
    ws.send(JSON.stringify(createTextChunk({
      text: introText,
      chunkId: introChunkId,
      isFirst: state.toolTurn === 1 && !state.hasSentIntro,
    })));
    audioSender.enqueue(introChunkId, introText, introVoiceParams);
    console.log(`  [Intro] ${introText}`);
    state.hasSentIntro = true;

    ws.send(JSON.stringify(createToolCall({
      tool: toolName,
      description: getToolDescription(toolName, toolArgs),
      estimatedSeconds: 3,
    })));
    console.log(`  [>] tool_call: ${toolName}`);

    const toolResult = await executeTool(toolName, toolArgs);
    if (toolResult && toolResult.error) {
      state.toolError = true;
      console.warn(`  [!] Tool returned error: ${toolResult.message}`);
    }

    messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
    messages.push({ role: 'tool', name: toolName, content: JSON.stringify(toolResult) });
  }

  return false;
}

// ─────────────────────────────────────────────
// 強制応答（ツールループが本文なしで抜けた場合）
// ─────────────────────────────────────────────

async function forceFinalResponse(ws, messages, state, io) {
  const { nextChunkId, audioSender, bodyVoiceParams } = io;

  const reason = state.toolsExecuted
    ? 'ツール実行後の本文生成（tools なし）'
    : state.hallucinatedTool
      ? '存在しないツール名が呼ばれたため'
      : state.exitedDueToDuplicate
        ? '同じ・類似ツールの重複呼出を防ぐため'
        : `最大ターン数(${MAX_TOOL_TURNS})に到達したため`;
  console.log(`  [>] Generating body without tools (${reason})`);

  // 長い指示は Gemma が空応答を返しやすいので簡潔に
  const forcePrompt = state.toolError
    ? '検索結果に一部失敗があったよ。得られた情報だけで、ライムキャラでユーザーに答えて。JSON形式 {"type":"chat","text":"...","emotions":{...}} で。'
    : '上の結果を踏まえて、ライムキャラでユーザーに答えて。JSON形式 {"type":"chat","text":"...","emotions":{...}} で。';

  messages.push({ role: 'user', content: forcePrompt });

  if (state.hasSentIntro) {
    ws.send(JSON.stringify(createBubbleBreak()));
    console.log('  [>] bubble_break sent (intro → forced body)');
  }

  if (!STREAMING_ENABLED) {
    // 一括生成版
    try {
      const result = await callLLM(messages);
      applyParsedContent(result, state, null);
    } catch (e) {
      console.warn(`  [!] Forced response failed: ${e.message}`);
    }
    if (state.finalText) {
      await sendTextAsChunks(ws, state.finalText, {
        nextChunkId, audioSender, voiceParams: bodyVoiceParams,
        isFirst: !state.hasSentIntro,
      });
      state.hasStreamedBody = true;
    }
    return;
  }

  // ストリーミング版（tools なしなので callLLMStream をそのまま使える）
  const extractor = new StreamingTextExtractor();
  const timer = createChunkTimer('body');
  let rawContent = '';
  let isFirst = !state.hasSentIntro;

  try {
    for await (const token of callLLMStream(messages)) {
      rawContent += token;
      const chunks = normalizeToChunks(extractor.feed(token));
      for (const chunk of chunks) {
        const chunkId = nextChunkId();
        ws.send(JSON.stringify(createTextChunk({ text: chunk, chunkId, isFirst })));
        audioSender.enqueue(chunkId, chunk, bodyVoiceParams);
        timer.mark(chunk);
        isFirst = false;
        state.hasStreamedBody = true;
      }
    }

    const remaining = normalizeToChunks(extractor.flush());
    for (const chunk of remaining) {
      const chunkId = nextChunkId();
      ws.send(JSON.stringify(createTextChunk({ text: chunk, chunkId })));
      audioSender.enqueue(chunkId, chunk, bodyVoiceParams);
      timer.mark(chunk);
      state.hasStreamedBody = true;
    }
  } catch (e) {
    console.warn(`  [!] Body streaming failed: ${e.message}`);
  }

  timer.summary();
  applyParsedContent(rawContent, state, extractor);
}

// ─────────────────────────────────────────────
// 完成した JSON から text / emotions / image_description を回収
// ─────────────────────────────────────────────

function applyParsedContent(rawContent, state, extractor) {
  const cleaned = stripJsonFence(rawContent);
  if (!cleaned) return;

  try {
    const parsed = JSON.parse(cleaned);

    if (parsed.text) state.finalText = parsed.text;

    const parsedEmotions = sanitizeEmotions(parsed.emotions);
    if (parsedEmotions) {
      state.finalRawEmotions = parsedEmotions;
    } else if (parsed.emotion) {
      state.finalRawEmotions = emotionToEmotions(parsed.emotion, parsed.intensity);
    }

    if (parsed.image_description) {
      state.imageDescription = parsed.image_description;
    }
  } catch (e) {
    console.warn(`  [!] Failed to parse LLM JSON: ${e.message}`);

    // JSON が壊れていても、抽出済みテキストがあれば本文として採用する
    if (extractor && typeof extractor.getImageDescription === 'function') {
      const desc = extractor.getImageDescription();
      if (desc) state.imageDescription = desc;
    }
    if (!state.finalText && !state.hasStreamedBody) {
      state.finalText = cleaned;
    }
  }
}

// ─────────────────────────────────────────────
// 非ストリーミング時のテキスト送信（句読点分割）
// ─────────────────────────────────────────────

async function sendTextAsChunks(ws, fullText, io) {
  const { nextChunkId, audioSender, voiceParams, isFirst } = io;
  if (!fullText) return;

  const chunks = splitIntoChunks(fullText);
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = nextChunkId();
    ws.send(JSON.stringify(createTextChunk({
      text: chunks[i],
      chunkId,
      isFirst: !!isFirst && i === 0,
    })));
    audioSender.enqueue(chunkId, chunks[i], voiceParams);
  }
}

function splitIntoChunks(text) {
  const chunks = [];
  let current = '';
  const BREAK_CHARS = /[。、!?\n]/;
  const MAX_LENGTH = 30;

  for (const ch of text) {
    current += ch;
    if (BREAK_CHARS.test(ch) || current.length >= MAX_LENGTH) {
      chunks.push(current);
      current = '';
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

main().catch(err => {
  console.error('[FATAL] Server startup failed:', err);
  process.exit(1);
});