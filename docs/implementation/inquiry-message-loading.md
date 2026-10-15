# 問い合わせメール履歴の遅延読込

## 目的

問い合わせ件数・メール履歴件数が増えた場合でも、問い合わせ画面の初期表示で `InquiryMessages` 全件本文を読み込まないようにする。

## 変更前

問い合わせ画面の初期表示で以下を一括取得していた。

- Customers
- CustomerContacts
- Members
- InquiryCategories
- Inquiries
- InquiryMessages 全件

`InquiryMessages.body` は長文になりやすいため、履歴件数の増加に比例して初期表示の転送量・GAS処理時間が増える構造だった。

## 変更後

### 初期表示

`getInquiryScreenData()` は以下のみ取得する。

- Customers
- CustomerContacts
- Members
- InquiryCategories
- Inquiries

`InquiryMessages` は取得しない。

### 問い合わせ選択時

`getInquiryMessages(inquiryId)` を呼び、選択した問い合わせの履歴だけを取得する。

処理は次の順序とする。

1. `InquiryMessages` のヘッダを取得
2. `inquiry_id` 列だけを走査
3. 対象 `inquiry_id` の行番号を抽出
4. 該当行だけ本文を含むデータを取得
5. `sent_at` 昇順で返却

クライアント側は取得済みの履歴を `messagesByInquiry` にキャッシュし、同じ問い合わせを再選択した場合は再取得しない。

## 期待効果

特にメール本文が長い場合、問い合わせ一覧の初期表示時に大量本文をサーバーからブラウザへ転送しなくてよくなる。

なお、問い合わせ選択時には `inquiry_id` 列の走査は残る。さらに件数が増え、これがボトルネックになった場合は次段階として以下を検討する。

- `Inquiries` に最新送信元など一覧用の冗長列を保持する
- 古い `InquiryMessages` のアーカイブ
- SpreadsheetからRDBへの移行

## 互換性

- 問い合わせの保存仕様は変更しない
- ダッシュボードから問い合わせを開いた場合もメール履歴を遅延取得する
- Gemini要約は従来どおりサーバー側で対象問い合わせの履歴を取得して実行する
