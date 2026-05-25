# RAiM WebSocket JSONスキーマ仕様

**バージョン**: 1
**最終更新**: 設計フェーズ
**配置場所**: `RAiM_serverside/docs/json-schema.md`

このドキュメントは、サーバー（Node.js / Lambda）と Flutter クライアントの間で WebSocket 経由でやり取りされる JSON メッセージの仕様を定義する。Flutter 実装時の参照ドキュメントとして使用する。

---

## 目次

1. [基本原則](#1-基本原則)
2. [メッセージの方向](#2-メッセージの方向)
3. [上り（Flutter → サーバー）](#3-上りflutter--サーバー)
4. [下り（サーバー → Flutter）](#4-下りサーバー--flutter)
   - 4.1 [`chat`：通常応答](#41-chat通常応答)
   - 4.2 [`filler_audio`：つなぎ言葉](#42-filler_audioつなぎ言葉)
   - 4.3 [`tool_call`：ツール実行要求](#43-tool_callツール実行要求)
   - 4.4 [`proactive_message`：ライム発信](#44-proactive_messageライム発信)
   - 4.5 [`error`：エラー通知](#45-errorエラー通知)
5. [共通フィールド規約](#5-共通フィールド規約)
6. [クライアント側の実装原則](#6-クライアント側の実装原則)
7. [将来の type 追加ガイドライン](#7-将来の-type-追加ガイドライン)
8. [Unity 連携の留意点](#8-unity-連携の留意点)

---

## 1. 基本原則

このスキーマは以下の3つの原則に従う。

### 1.1 サーバーが唯一の真実（Source of Truth）

JSON の構造を決めるのはサーバー側のみ。Flutter はサーバーから受け取った JSON を解釈・表示・転送するだけで、自分から JSON 構造を判断したりロジックを持ったりしない。これは設計ドキュメント第6章「プロンプトをサーバー側に隠す設計上のメリット」の徹底。

### 1.2 追加に寛容、変更に厳格

- **新しいフィールドの追加**：いつでも可能。クライアントは未知のフィールドを無視する
- **新しい type の追加**：いつでも可能。クライアントは未知の type を無視する
- **既存フィールドの削除・型変更**：破壊的変更。`version` を上げてクライアントの対応が必要

### 1.3 バージョニング

すべての下り（サーバー → Flutter）メッセージに `version` フィールドを含める。現行バージョンは `1`。

```json
{
  "version": 1,
  "type": "chat",
  ...
}
```

将来、構造が破壊的に変わる場合は `version: 2` 等で並行サポートする。

---

## 2. メッセージの方向

| 方向 | 送信元 | 受信先 | 主な目的 |
| --- | --- | --- | --- |
| 上り | Flutter | サーバー（Node.js / Lambda） | ユーザー発言の送信 |
| 下り | サーバー | Flutter | ライムの応答・通知 |

下り方向は1回の発言に対して**複数メッセージが送られる場合がある**（例：`filler_audio` の後に `chat` が続く）。

---

## 3. 上り（Flutter → サーバー）

### 3.1 ユーザー発言の送信

```json
{
  "text": "なんか疲れたなー"
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `text` | string | ✅ | ユーザーが入力したテキスト |

#### 将来追加予定の上りフィールド

| フィールド | 型 | 用途 | 時期 |
| --- | --- | --- | --- |
| `image` | string (base64) | カメラ画像の送信 | マルチモーダル化フェーズ |
| `client_time` | string (ISO8601) | クライアント側の時刻情報 | 時刻認識フェーズ |
| `location` | object | 位置情報 | 状況認識フェーズ |
| `session_id` | string | 会話セッション識別子 | 長期記憶フェーズ |

これらを追加する時は、サーバー側で「あれば使う、なくても動く」設計にする（後方互換性）。

---

## 4. 下り（サーバー → Flutter）

### 4.1 `chat`：通常応答

ライムの通常の発言。Flutter はテキストをチャット UI に追加し、VOICEVOX で音声再生し、Unity に emotion を転送する。

```json
{
  "version": 1,
  "type": "chat",
  "text": "お疲れ様。あんまり無理しないでね？",
  "emotion": "caring",
  "intensity": 0.7
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `version` | integer | ✅ | スキーマバージョン（現行は1） |
| `type` | string | ✅ | 固定値 `"chat"` |
| `text` | string | ✅ | ライムの発言内容 |
| `emotion` | string | ✅ | 感情ラベル（許容値は [5.1](#51-emotion) 参照） |
| `intensity` | number | ✅ | 感情の強さ 0.0〜1.0 |

#### Flutter での処理フロー

1. チャット UI に吹き出しを追加
2. VOICEVOX に `text` を送信して音声再生
3. Unity（UnityBridge 経由）に `emotion` と `intensity` を転送

---

### 4.2 `filler_audio`：つなぎ言葉

「ちょっと待ってね」のような短いつなぎセリフ。Flutter はチャット UI には**追加せず**、音声だけ再生する。これにより、裏で重い処理（検索 + 再推論など）を実行中であることをユーザーに体感させない。

```json
{
  "version": 1,
  "type": "filler_audio",
  "text": "んー、ちょっと待ってね。今調べるから……",
  "emotion": "neutral",
  "intensity": 0.5
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `version` | integer | ✅ | スキーマバージョン |
| `type` | string | ✅ | 固定値 `"filler_audio"` |
| `text` | string | ✅ | つなぎセリフ |
| `emotion` | string | ✅ | 感情ラベル |
| `intensity` | number | ✅ | 感情の強さ |

#### Flutter での処理フロー

1. **チャット UI には追加しない**（`chat` との最大の違い）
2. VOICEVOX に `text` を送信して音声再生
3. Unity に `emotion` と `intensity` を転送（軽く表情を変えてもOK）

#### 設計上の意図

このメッセージの直後（または音声再生中）に `chat` 型の本回答が届く。Flutter は両方を順番に処理する。

---

### 4.3 `tool_call`：ツール実行要求

サーバーが「これは検索やツール実行が必要」と判断した時の通知メッセージ。**実際のツール実行はサーバー側で行う**ため、Flutter は単に「ライムが何かを調べている」状態を UI に表示するだけ。

```json
{
  "version": 1,
  "type": "tool_call",
  "tool": "web_search",
  "description": "天気情報を調べています",
  "estimated_seconds": 3
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `version` | integer | ✅ | スキーマバージョン |
| `type` | string | ✅ | 固定値 `"tool_call"` |
| `tool` | string | ✅ | ツール名（`"web_search"`、将来 `"calendar"` `"camera"` 等） |
| `description` | string | ✅ | ユーザー向けの説明テキスト（UI 表示用） |
| `estimated_seconds` | integer | ⚪ | 推定所要秒数（プログレスバー表示用、任意） |

#### Flutter での処理フロー

1. UI に「調べ中…」のようなインジケーター表示
2. `description` を必要に応じて表示
3. ツール実行完了後、サーバーから `chat` 型の本回答が届く → インジケーターを消して通常応答として処理

#### 設計上の意図

`filler_audio`（音声でごまかす）と `tool_call`（UI で可視化する）の使い分け：
- 短時間（〜2秒）の処理 → `filler_audio` で「考えてる感」を演出
- 長時間（3秒〜）の処理 → `tool_call` で「ライムが何かを調べてる」を明示

実装フェーズでは、まず `filler_audio` のみで運用し、必要になったら `tool_call` を導入する段階的アプローチを推奨。

---

### 4.4 `proactive_message`：ライム発信

ユーザーが話しかけてないのに、ライム側から能動的に発信するメッセージ。`chat` とほぼ同じ構造だが、`trigger` フィールドで「なぜ話しかけてきたか」を伝える。

```json
{
  "version": 1,
  "type": "proactive_message",
  "text": "もう深夜だよ？早く寝た方がいいんじゃないかな……",
  "emotion": "caring",
  "intensity": 0.7,
  "trigger": "late_night_warning"
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `version` | integer | ✅ | スキーマバージョン |
| `type` | string | ✅ | 固定値 `"proactive_message"` |
| `text` | string | ✅ | ライムの発言 |
| `emotion` | string | ✅ | 感情ラベル |
| `intensity` | number | ✅ | 感情の強さ |
| `trigger` | string | ⚪ | 発信のきっかけ識別子（任意、ログ・分析用） |

#### `trigger` の取りうる値（例）

| 値 | 意味 |
| --- | --- |
| `morning_greeting` | 朝の挨拶 |
| `late_night_warning` | 深夜の注意喚起 |
| `schedule_reminder` | カレンダー予定のリマインド |
| `long_silence` | 一定時間沈黙が続いた時 |

#### Flutter での処理フロー

`chat` と同じ。`trigger` は基本的に Flutter では使わず、表示のためには `text` `emotion` `intensity` だけで足りる。

#### 設計上の意図

このメッセージはユーザー入力をトリガーとしない。サーバー側のスケジューラまたは状況検知ロジックが投げる。Flutter 側は WebSocket 接続を維持してさえいれば、いつでも受信できる。

---

### 4.5 `error`：エラー通知

サーバー側で何らかの問題が起きた時の通知。Flutter は UI に表示してユーザーに知らせる、または無視して再試行する。

```json
{
  "version": 1,
  "type": "error",
  "code": "LLM_TIMEOUT",
  "message": "ライムからの応答が遅延しています。再度お試しください。",
  "retriable": true
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `version` | integer | ✅ | スキーマバージョン |
| `type` | string | ✅ | 固定値 `"error"` |
| `code` | string | ✅ | エラーコード（[5.2](#52-error-コード一覧) 参照） |
| `message` | string | ✅ | ユーザー向けのエラーメッセージ |
| `retriable` | boolean | ⚪ | 同じリクエストを再送しても良いか |
| `details` | object | ⚪ | デバッグ用詳細情報（本番では送らない） |

#### Flutter での処理フロー

1. UI にエラー表示（控えめなトースト等を推奨）
2. `retriable: true` なら自動再試行も検討可
3. **重要**：`retriable: false` でループしないよう注意

---

## 5. 共通フィールド規約

### 5.1 `emotion`

ライムの感情を表す文字列。**Unity 側の立ち絵スプライトと連動する**ため、許容値は Unity 実装と整合させる。

#### 現行の許容値（Unity 立ち絵5種に対応）

| 値 | Unity 立ち絵 | 用途 |
| --- | --- | --- |
| `neutral` | default | 通常状態 |
| `happy` | happy | 喜び・楽しい |
| `sad` | sad | 悲しみ・落ち込み |
| `angry` | angry | 怒り・苛立ち |
| `surprised` | surprise | 驚き |

#### 拡張的に使われる値（現状の Unity では default にフォールバック）

| 値 | 意味 | Unity 対応時期 |
| --- | --- | --- |
| `caring` | 思いやり・優しさ | 立ち絵追加時 |
| `embarrassed` | 照れ・困惑 | 立ち絵追加時 |
| `excited` | 興奮・テンション高 | 立ち絵追加時 |

#### Flutter / Unity 側のフォールバックルール

未知の emotion 値を受信した場合：
- Flutter：そのまま `emotion` フィールドを Unity に転送する
- Unity：対応する立ち絵がない場合は `default` を表示

これにより、サーバー側で新しい emotion を追加してもクライアントがクラッシュしない。

### 5.2 `error` コード一覧

| code | 意味 | retriable |
| --- | --- | --- |
| `LLM_TIMEOUT` | LLM 応答タイムアウト | true |
| `LLM_ERROR` | LLM 推論エラー | true |
| `EMBED_ERROR` | Embedding 計算エラー | true |
| `INVALID_INPUT` | リクエスト形式が不正 | false |
| `INTERNAL_ERROR` | サーバー内部エラー（詳細不明） | true |
| `RATE_LIMIT` | レート制限（連続リクエスト過多） | true |
| `MAINTENANCE` | メンテナンス中 | false |

将来追加する場合は、大文字スネークケースで命名する（例：`SEARCH_API_ERROR`）。

### 5.3 `intensity`

感情の強さ。0.0（最弱）〜1.0（最強）の浮動小数点。

| 範囲 | 意味 | 用途例 |
| --- | --- | --- |
| 0.0〜0.3 | 弱い | 軽い感情、抑えた表現 |
| 0.4〜0.6 | 中程度 | 標準的な反応 |
| 0.7〜0.9 | 強い | 強い感情、テンション高 |
| 1.0 | 最大 | クライマックス |

#### Unity での活用

Unity 側で `intensity` を使って以下のような表現が可能：
- 表情の濃淡（眉の角度、口の開き）
- ボディアニメーションの大小
- カメラズーム量

---

## 6. クライアント側の実装原則

Flutter（クライアント）が守るべき4原則。

### 6.1 未知の type は無視する

```dart
void handleMessage(Map<String, dynamic> data) {
  switch (data['type']) {
    case 'chat':
      _handleChat(data);
      break;
    case 'filler_audio':
      _handleFiller(data);
      break;
    case 'tool_call':
      _handleToolCall(data);
      break;
    case 'proactive_message':
      _handleProactive(data);
      break;
    case 'error':
      _handleError(data);
      break;
    default:
      // ❌ throw Exception('Unknown type');  ← これは絶対ダメ
      print('[WARN] Unknown message type: ${data['type']}, ignoring');
      // ✅ 無視する
      break;
  }
}
```

### 6.2 必須フィールドが欠けていても落ちない

```dart
// ❌ クラッシュリスク
final emotion = data['emotion'] as String;

// ✅ デフォルト値を持つ
final emotion = (data['emotion'] as String?) ?? 'neutral';
final intensity = (data['intensity'] as num?)?.toDouble() ?? 0.5;
final text = (data['text'] as String?) ?? '';
```

### 6.3 未知のフィールドは無視する

サーバーが新しいフィールドを追加してきても、Flutter は知らないフィールドを単に無視すればよい。dart の Map はそういう動きなので自然に達成される。

### 6.4 version を確認する

```dart
final version = (data['version'] as int?) ?? 0;
if (version > 1) {
  // 将来サーバーがv2を送ってきた場合のフォールバック
  print('[WARN] Newer schema version $version detected. May not support all features.');
}
```

破壊的変更が必要になった時のために、version の確認だけ最初から仕込んでおく。

---

## 7. 将来の type 追加ガイドライン

新しい type を追加する時のチェックリスト：

- [ ] type 名は **小文字スネークケース**（`tool_call`、`proactive_message` など）
- [ ] このスキーマドキュメントに新章を追加
- [ ] `version` は変更しない（追加は破壊的変更ではない）
- [ ] Flutter 側の switch に新分岐を追加
- [ ] サーバー側の型定義（`lib/types.js`）にも追加
- [ ] 既存 type の動作に影響しないこと確認

#### type 命名規則

| 命名 | 用途の傾向 |
| --- | --- |
| 名詞単独（例：`chat`、`error`） | 状態・実体 |
| 動詞_名詞（例：`tool_call`、`expression_change`） | アクション要求 |
| 形容詞_名詞（例：`proactive_message`、`filler_audio`） | 限定的なメッセージ種別 |

---

## 8. Unity 連携の留意点

Flutter → Unity の WebSocket（8765）には、サーバーから来た JSON のうち、**Unity が必要とするフィールドだけ**を抽出して転送する。

### 8.1 Unity への転送 JSON（例）

```json
{
  "emotion": "caring",
  "intensity": 0.7
}
```

Unity は `emotion` で立ち絵を切り替え、`intensity` で表情の濃淡を調整する。

### 8.2 転送しないフィールド

- `text`：Unity は喋らない（VOICEVOX 担当）
- `version`、`type`：Flutter 側の制御情報
- `tool` などの type 固有フィールド：Unity と無関係

### 8.3 type 別の Unity 転送ポリシー

| type | Unity に転送 | 理由 |
| --- | --- | --- |
| `chat` | ✅ する | 喋るシーンなので表情変化 |
| `filler_audio` | ✅ する | 短時間でも表情で「考え中」を表現 |
| `tool_call` | △ 任意 | 「調べ中」ポーズがあれば送ってもよい |
| `proactive_message` | ✅ する | 発話なので表情変化 |
| `error` | ❌ しない | UI レベルの問題、立ち絵に影響しない |

---

## 付録：完全なメッセージ例集

### 通常会話

```
Flutter → サーバー: {"text":"なんか疲れた"}
サーバー → Flutter: {"version":1,"type":"chat","text":"お疲れ様。あんまり無理しないでね？","emotion":"caring","intensity":0.7}
```

### 検索を伴う会話（つなぎ言葉つき）

```
Flutter → サーバー: {"text":"今日の天気って何？"}

サーバー → Flutter: {"version":1,"type":"filler_audio","text":"んー、ちょっと待ってね。今調べるから……","emotion":"neutral","intensity":0.5}

(数秒後)

サーバー → Flutter: {"version":1,"type":"chat","text":"えっと、今日は晴れみたいだよ。","emotion":"happy","intensity":0.6}
```

### エラーケース

```
Flutter → サーバー: {"text":"こんにちは"}

サーバー → Flutter: {"version":1,"type":"error","code":"LLM_TIMEOUT","message":"応答が遅れています。もう一度お試しください。","retriable":true}
```

### ライム発信

```
(ユーザー入力なし、サーバー側スケジューラから発火)

サーバー → Flutter: {"version":1,"type":"proactive_message","text":"おはよう！今日はどんな一日にする？","emotion":"happy","intensity":0.7,"trigger":"morning_greeting"}
```

---

## 更新履歴

- **v1.0**：初版。type は `chat` / `filler_audio` / `tool_call` / `proactive_message` / `error` の5種類。emotion は Unity 立ち絵5種（neutral/happy/sad/angry/surprised）+ 拡張値（caring/embarrassed/excited）。

*このドキュメントは Flutter 実装の道しるべ。実装中に判明した変更点は都度反映する。*