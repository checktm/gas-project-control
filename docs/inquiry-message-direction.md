# 問い合わせメール方向判定

## 1. 目的

問い合わせメールは顧客との往復を前提とするため、Gmailスレッド内の各メッセージを `INBOUND` / `OUTBOUND` に分けて保存する。

顧客・顧客担当者の自動判定には、顧客から自社へ届いた `INBOUND` メールの送信元だけを利用する。

## 2. 自社側メールアドレス

方向判定では以下を自社側メールアドレスとして扱う。

- `INQUIRY_GROUP_ADDRESS`
- Apps Script実行ユーザーのメールアドレス
- Apps Scriptアクティブユーザーのメールアドレス（取得可能な場合）
- Gmailの送信元エイリアス

## 3. 方向判定

各Gmailメッセージについて以下の順で判定する。

1. `From` が自社側メールアドレスに一致する場合は `OUTBOUND`
2. それ以外で `To` または `Cc` に自社側メールアドレスが含まれる場合は `INBOUND`
3. どちらにも該当しない場合は誤取込防止のため対象外

この判定は `To` だけを見て判断しない。

## 4. Inquiry作成

新しいInquiryは `INBOUND` メールを起点として作成する。

Gmail検索はスレッド単位で返るため、同じスレッド内に古い `OUTBOUND` が存在する場合がある。その時点でInquiryが未作成なら、その `OUTBOUND` は新規Inquiryの起点にはしない。

## 5. 顧客・担当者判定

顧客・担当者の自動判定は `INBOUND` の `From` を利用する。

- `CustomerContacts.email` 完全一致 → `EXACT_CONTACT`
- 担当者一致なし、`Customers.domain` 一意一致 → `DOMAIN_MATCH`
- 複数候補 → `AMBIGUOUS`
- 一致なし → `UNMATCHED`

`OUTBOUND` の `From` は顧客判定には利用しない。

## 6. 既存Inquiryへの追加

同じ `gmail_thread_id` のInquiryが存在する場合、方向判定後のメッセージを同一Inquiryの `InquiryMessages` に追加する。

アプリ画面から送信した返信は送信時点で `OUTBOUND` として保存される。後続のGmail取込では `gmail_message_id` により二重登録を防止する。

## 7. 未特定再判定

「未特定を再判定」では、`InquiryMessages` のうち最新の `INBOUND` の `from_email` を利用する。

`OUTBOUND` は再判定対象の送信元として利用しない。
