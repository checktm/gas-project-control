# 問い合わせ顧客再判定

## 目的

問い合わせ取込時点では顧客・顧客担当者マスタが未登録で `UNMATCHED` / `AMBIGUOUS` になった問い合わせを、後から登録・修正した現在のマスタで再判定できるようにする。

## 対象

再判定対象は `customer_match_status` が以下の問い合わせだけとする。

- `UNMATCHED`
- `AMBIGUOUS`

以下は自動再判定で上書きしない。

- `EXACT_CONTACT`
- `DOMAIN_MATCH`
- `MANUAL`

## 判定ルール

既存のメール取込時判定と同じ `matchCustomer_()` を利用する。

1. 受信メール送信元と `CustomerContacts.email` の完全一致
   - Customer / CustomerContactを設定
   - `EXACT_CONTACT`
2. 完全一致しない場合、送信元ドメインと `Customers.domain` を照合
   - 一意ならCustomerだけを設定
   - `DOMAIN_MATCH`
3. 複数候補
   - `AMBIGUOUS`
4. 一致なし
   - `UNMATCHED`

同一問い合わせに複数の受信メールがある場合は、最新の `INBOUND` メール送信元を再判定に利用する。

## UI

問い合わせ一覧上部に `未特定を再判定` ボタンを表示する。

実行時は対象件数を確認してから一括処理し、完了後に以下を表示する。

- 再判定対象件数
- 自動特定できた件数
- 未特定のまま残った件数

再判定後は問い合わせ一覧とダッシュボードを再描画する。

## 性能

再判定では `InquiryMessages.body` を読み込まない。

`inquiry_id` / `direction` / `from_email` / `sent_at` の必要列だけを走査し、メール本文件数増加による不要な読み込みを避ける。

## 安全性

- 手動設定済み問い合わせは上書きしない
- 既に自動確定済みの問い合わせも上書きしない
- 顧客・担当者マスタの現在値を正本として再判定する
