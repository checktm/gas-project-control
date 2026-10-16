# 問い合わせメール方向判定

## 1. 目的

問い合わせメールは顧客との往復を前提とするため、Gmailスレッド内の各メッセージを `INBOUND` / `OUTBOUND` に分けて保存する。

顧客・顧客担当者の自動判定には、顧客から自社へ届いた `INBOUND` メールの送信元だけを利用する。

## 2. 自社側メール設定

方向判定の正本として、Settings に以下を持つ。

- `INTERNAL_MAIL_DOMAINS`
  - 自社送信と判定するメールドメイン
  - 複数ある場合はカンマ、改行、セミコロン区切り
- `INTERNAL_MAIL_ADDRESSES`
  - ドメイン判定だけでは扱いにくい共有・特殊メールアドレス
  - 複数ある場合はカンマ、改行、セミコロン区切り

補助的に以下も自社側メールアドレスとして扱う。

- `INQUIRY_GROUP_ADDRESS`
- Apps Script実行ユーザーのメールアドレス
- Apps Scriptアクティブユーザーのメールアドレス（取得可能な場合）
- Gmailの送信元エイリアス

複数人が同一問い合わせへ返信する運用では、Apps Script実行ユーザーだけでは判定できないため、`INTERNAL_MAIL_DOMAINS` の設定を基本とする。

## 3. 方向判定

各Gmailメッセージについて以下の順で判定する。

1. `From` が `INTERNAL_MAIL_ADDRESSES` または `INTERNAL_MAIL_DOMAINS` に該当する場合は `OUTBOUND`
2. `From` が取得でき、1に該当しない場合は `INBOUND`
3. `From` が取得できない場合だけ、`To` / `Cc` に自社側メールが含まれるかを補助判定する
4. 判定できない場合は取込対象外

画面上の「受信」「送信」は、この判定結果を `InquiryMessages.direction` に保存した値を表示する。

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

## 7. 過去データの再判定

以前の実装で誤った `direction` が保存されている場合は、`reclassifyInquiryMessageDirections()` を一度実行して補正する。

実行条件:

- `INTERNAL_MAIL_DOMAINS` または `INTERNAL_MAIL_ADDRESSES` を事前に設定する
- `InquiryMessages.from_email` を利用して全既存メッセージを再判定する
- Fromが自社側なら `OUTBOUND`、それ以外は `INBOUND` とする

この処理はメール本文・Gmail ID・問い合わせ紐付けを変更せず、`direction` だけを補正する。

## 8. 未特定再判定

「未特定を再判定」では、補正済みの `InquiryMessages` のうち最新の `INBOUND` の `from_email` を利用する。

`OUTBOUND` は再判定対象の送信元として利用しない。
