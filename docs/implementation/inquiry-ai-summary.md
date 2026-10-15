# Gemini 問い合わせ要約 実装方針

正本仕様: `docs/ai/inquiry-summary.md`

## 1. 実装対象

追加:

- `src/GeminiService.gs`
- `src/InquiryAiApi.gs`

変更:

- `src/Index.html`
- `src/InquiryScript.html`
- 必要に応じて `src/InquiryStyles.html`
- `src/MasterApi.gs` / `src/MasterScript.html`（Gemini設定をシステム設定画面で扱う場合）

既存の問い合わせ保存API・メール取込処理の責務は変更しない。

## 2. 設定

### 2.1 Secret

Apps Script Script Properties:

- `GEMINI_API_KEY`

### 2.2 通常設定

Settingsシート候補:

- `GEMINI_AI_ENABLED` = TRUE / FALSE
- `GEMINI_MODEL` = 利用するモデルID
- `GEMINI_MAX_INPUT_CHARS` = 最大入力文字数

APIキーはSettingsシートへ置かない。

## 3. サーバーAPI

```javascript
function generateInquirySummary(inquiryId)
```

入力:

```javascript
{
  inquiryId: '...'
}
```

クライアントからは文字列だけ渡してもよいが、既存API規約に合わせる。

成功レスポンス:

```javascript
{
  summary: '生成された概要',
  generatedAt: '2026-10-15T00:00:00.000Z',
  model: '...'
}
```

失敗時は例外を投げ、クライアントの `withFailureHandler` で表示する。

## 4. 入力組み立て

1. `inquiryId` からInquiryを取得
2. 同じ `inquiry_id` のInquiryMessagesを取得
3. `sent_at` 昇順にソート
4. 各メッセージを次形式へ整形

```text
[2026/10/15 10:00] INBOUND customer@example.com
件名: ○○について
本文:
...
```

5. 署名・過去引用を可能な範囲で除去
6. 最大入力文字数を超える場合は最新メッセージを優先して古い本文を短縮
7. プロンプトに埋め込む

## 5. Gemini API呼出し

`UrlFetchApp.fetch()` から Gemini API `models.generateContent` をPOSTする。

APIキーは `x-goog-api-key` ヘッダーで送る方式を優先する。

リクエスト例:

```javascript
const response = UrlFetchApp.fetch(url, {
  method: 'post',
  contentType: 'application/json',
  headers: {
    'x-goog-api-key': apiKey
  },
  payload: JSON.stringify({
    contents: [{
      role: 'user',
      parts: [{text: prompt}]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512
    }
  }),
  muteHttpExceptions: true
});
```

モデル名は設定値からURLへ入れる。

## 6. レスポンス解析

基本取得位置:

```text
candidates[0].content.parts[].text
```

partsが複数ある場合はtextを連結する。

以下の場合は失敗扱い:

- HTTP 2xx以外
- candidatesなし
- textなし
- 空文字

レスポンス全文やAPIキーを利用者向けエラーや通常ログへ出さない。

## 7. クライアントUI

概要欄のラベル付近にボタンを置く。

```text
概要                         [AIで要約]
┌──────────────────────────────┐
│ 生成候補 / 手入力             │
└──────────────────────────────┘
```

`AIで要約` 押下時:

```javascript
google.script.run
  .withSuccessHandler(...)
  .withFailureHandler(...)
  .generateInquirySummary(inquiryId);
```

成功時:

- `inquirySummaryInput.value = result.summary`
- まだDB保存しない
- `inquiryFormMessage` に確認を促す文言を表示

既存概要が非空の場合:

- 初期実装では `confirm()` 等で上書き確認してから実行、または結果だけ別表示して「概要へ反映」を押させる
- UI品質を優先するなら後者が望ましい

## 8. 推奨UI案

初期実装では既存概要を誤って消さないため、次の構成を推奨する。

```text
概要                         [AIで要約]
┌──────────────────────────────┐
│ 現在の概要                    │
└──────────────────────────────┘

AI要約候補
┌──────────────────────────────┐
│ Geminiが生成した候補           │
└──────────────────────────────┘
              [概要へ反映]
```

- `AIで要約` は候補生成のみ
- `概要へ反映` でtextareaへコピー
- 最終確定は既存の `保存`

この3段階にすることで、AI実行だけで人の編集内容を失わない。

## 9. 動作確認

最低限のテスト:

1. APIキー未設定
2. AI無効
3. メール1通
4. 複数メールスレッド
5. 非常に長いメール
6. 日本語メール
7. 英語メール
8. 既存概要あり
9. Gemini APIエラー
10. レート制限
11. AI失敗後も通常保存可能
12. AI生成だけではSpreadsheetが更新されない

## 10. 実装判断

初回は「AI要約候補」だけ実装する。

分類・優先度・次回対応を同じAPIで一括生成できる構造へ過度に一般化しない。要約品質と運用価値を確認してから、必要な項目ごとに追加する。
