# Gemini 問い合わせ要約仕様 v0.1

## 1. 目的

問い合わせ詳細画面から、問い合わせに紐づくメール履歴を Gemini API へ渡し、担当者が短時間で内容を把握できる「概要」候補を生成する。

初期実装では AI の出力を自動確定しない。利用者が「AIで要約」を実行し、生成結果を概要欄へ候補として反映した後、必要に応じて修正して保存する。

## 2. 初期スコープ

対象:

- 問い合わせ詳細画面の「概要」生成
- Inquiry に紐づく InquiryMessage の本文・件名を入力に使用
- 既存の `Inquiries.summary` を保存先として利用
- AI生成結果は保存前に利用者が確認・修正可能

初期対象外:

- 自動分類
- 自動優先度判定
- 自動担当者割当
- `next_action` の自動確定
- メール取込時の無条件自動要約
- AI出力の自動保存

## 3. UI

問い合わせ詳細の「概要」欄付近に `AIで要約` ボタンを追加する。

### 3.1 操作フロー

```text
問い合わせを選択
  ↓
「AIで要約」
  ↓
処理中表示
  ↓
Geminiで要約候補生成
  ↓
概要欄へ候補を反映
  ↓
利用者が確認・必要なら修正
  ↓
既存の「保存」ボタンで確定
```

### 3.2 表示ルール

- AI実行中はボタンを無効化し、`要約中...` と表示する。
- 成功時は概要欄へ候補を設定し、`AI要約を生成しました。内容を確認して保存してください。` と表示する。
- AI実行だけでは `Inquiries.summary` を更新しない。
- 既存の概要がある場合、上書き前に確認を求めるか、初期実装では既存概要が空のときだけ直接反映する。
- 失敗時は現在の概要を保持し、エラーを画面表示する。

## 4. 要約内容

AIには次の観点を優先して要約させる。

1. 問い合わせの主旨
2. 顧客が求めていること
3. 期限・希望日・日時など重要な条件
4. 重要な前提・制約
5. 現在までのやり取りで確定している事項

要約は日本語で、原則 3〜6行程度の短い文章とする。

不明な情報を推測で補わない。

### 4.1 推奨プロンプト

```text
あなたは業務問い合わせを整理するアシスタントです。
以下のメール履歴を、担当者が短時間で状況把握できる日本語の概要にしてください。

要件:
- 3〜6行程度で簡潔にまとめる
- 問い合わせの主旨と、顧客が求めていることを優先する
- 期限・希望日・重要条件があれば含める
- メールに書かれていない内容を推測しない
- 挨拶、署名、定型文は原則省略する
- 事実と推測を混同しない

メール履歴:
{{MAIL_HISTORY}}
```

## 5. 入力データ

対象 Inquiry に紐づく InquiryMessage を `sent_at` 昇順で取得する。

Geminiへ渡す内容:

- direction
- sent_at
- from_email
- subject
- body

内部ID、Gmail message ID、Gmail thread ID は要約生成には送信しない。

### 5.1 長文対策

初期実装では入力上限を設ける。

- 最新メールを優先する
- 長い署名・引用返信を可能な範囲で除去する
- 最大文字数は設定値で制御可能にする
- 上限超過時は古い本文から省略する

## 6. GAS実装方針

AI呼出しを問い合わせAPIや画面処理へ直接埋め込まず、専用サービスに分離する。

推奨ファイル:

```text
src/GeminiService.gs
src/InquiryAiApi.gs
```

### 6.1 `GeminiService.gs`

責務:

- APIキー取得
- Gemini API呼出し
- HTTPエラー処理
- レスポンス解析
- タイムアウト・空レスポンス検証

主関数例:

```javascript
function generateGeminiText_(prompt) {
  // Gemini APIを呼び、生成テキストを返す。
}
```

### 6.2 `InquiryAiApi.gs`

責務:

- inquiryId の検証
- 対象Inquiry / InquiryMessageの取得
- 要約用入力組み立て
- GeminiService呼出し
- 画面用レスポンス作成

公開関数例:

```javascript
function generateInquirySummary(inquiryId) {
  // { summary: '...', generatedAt: '...' } を返す。
}
```

AI生成時には `Inquiries` シートを書き換えない。

## 7. Gemini API

GASからREST APIを `UrlFetchApp.fetch()` で呼び出す。

利用エンドポイントは Gemini API の `models.generateContent` とする。

モデル名をコードへ固定せず、設定から取得する。

初期モデル候補は低遅延・低コストの Flash 系モデルとし、環境で利用可能な現行モデルを設定する。

設定キー例:

- `GEMINI_AI_ENABLED`
- `GEMINI_MODEL`
- `GEMINI_MAX_INPUT_CHARS`

APIキーは `Settings` シートへ保存しない。

## 8. APIキー管理

Gemini APIキーは Apps Script の Script Properties に保存する。

キー名:

```text
GEMINI_API_KEY
```

取得例:

```javascript
const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
```

APIキーが未設定の場合は、利用者向けに `Gemini APIキーが設定されていません。` と分かるエラーを返す。

GitHubリポジトリ、HTML、Spreadsheet、ログへAPIキーを出力しない。

## 9. エラー処理

以下を区別して扱う。

- AI機能無効
- APIキー未設定
- inquiryId 不正
- 対象メールなし
- Gemini API HTTPエラー
- レート制限
- レスポンス形式不正
- 生成テキスト空

AI要約失敗によって通常の問い合わせ閲覧・編集・保存を妨げない。

## 10. セキュリティ・情報取扱い

メール本文は Gemini API へ送信されるため、導入前に利用組織として外部AIサービスへ業務メールを送信してよいかを確認する。

初期実装では、要約に不要な内部ID等は送信しない。

APIキーはサーバー側のみで利用し、クライアントJavaScriptへ返さない。

## 11. 将来拡張

要約品質を確認後、必要に応じて以下を追加検討する。

- `category` 候補
- `priority` 候補
- `next_action` 候補
- メール取込後のバックグラウンド要約
- 長いスレッドの差分要約
- AI生成日時・生成モデルの監査情報

ただし、業務ルールに影響する値を自動確定する場合は別途仕様化する。

## 12. 実装順序

1. Script Propertiesへ `GEMINI_API_KEY` 設定
2. GeminiService実装
3. InquiryAiApi実装
4. 問い合わせ詳細に `AIで要約` ボタン追加
5. 成功・失敗・処理中UI追加
6. 空概要で要約生成テスト
7. 既存概要ありの場合の上書き防止確認
8. 実メールで品質確認
9. 必要に応じてプロンプト調整
