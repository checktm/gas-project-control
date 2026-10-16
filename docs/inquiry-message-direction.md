# 問い合わせメール方向判定

## 1. 目的

問い合わせメールは顧客との往復を前提とするため、Gmailスレッド内の各メッセージを `INBOUND` / `OUTBOUND` に分けて保存する。

顧客・顧客担当者の自動判定には、顧客から自社へ届いた `INBOUND` メールの送信元だけを利用する。

## 2. 自社側メール設定

方向判定では、自社ドメインとシステム内のマスタ情報から自社側メールを決める。

Settings:

- `INTERNAL_MAIL_DOMAINS`
  - 自社送信と判定するメールドメイン
  - 複数ある場合はカンマ、改行、セミコロン区切り
- `INQUIRY_GROUP_ADDRESS`
  - 問い合わせ受付アドレス
  - 既存key名は維持するが複数値を登録できる
  - 複数ある場合はカンマ、改行、セミコロン区切り

個別の自社メールアドレスは手入力設定を持たず、次から自動生成する。

- 有効な `Members.email`
- `INQUIRY_GROUP_ADDRESS` に登録したすべての問い合わせ受付アドレス

`INTERNAL_MAIL_ADDRESSES` は方向判定には利用しない。

## 3. 方向判定

各Gmailメッセージについて以下の順で判定する。

1. `From` が自社ドメインに属する場合は `OUTBOUND`
2. `From` が有効な社内メンバーのメールアドレスに一致する場合は `OUTBOUND`
3. `From` が問い合わせ受付アドレスに一致する場合は `OUTBOUND`
4. `From` が取得でき、1〜3に該当しない場合は `INBOUND`
5. `From` が取得できない場合だけ、`To` / `Cc` に自社側メールが含まれるかを補助判定する
6. 判定できない場合は取込対象外

画面上の「受信」「送信」は、この判定結果を `InquiryMessages.direction` に保存した値を表示する。

## 4. 複数の問い合わせ受付アドレス

`INQUIRY_GROUP_ADDRESS` には複数の受付アドレスを登録できる。

例:

```text
support@example.co.jp, sales@example.co.jp
```

既存の `MAIL_SEARCH_QUERY` が `to:{GROUP_ADDRESS}` を利用している場合、取込時に各受付アドレスへのGmail OR検索へ展開する。

単一受付アドレスの既存設定はそのまま利用できる。

## 5. Inquiry作成

新しいInquiryは `INBOUND` メールを起点として作成する。

Gmail検索はスレッド単位で返るため、同じスレッド内に古い `OUTBOUND` が存在する場合がある。その時点でInquiryが未作成なら、その `OUTBOUND` は新規Inquiryの起点にはしない。

## 6. 顧客・担当者判定

顧客・担当者の自動判定は `INBOUND` の `From` を利用する。

- `CustomerContacts.email` 完全一致 → `EXACT_CONTACT`
- 担当者一致なし、`Customers.domain` 一意一致 → `DOMAIN_MATCH`
- 複数候補 → `AMBIGUOUS`
- 一致なし → `UNMATCHED`

`OUTBOUND` の `From` は顧客判定には利用しない。

## 7. 既存Inquiryへの追加

同じ `gmail_thread_id` のInquiryが存在する場合、方向判定後のメッセージを同一Inquiryの `InquiryMessages` に追加する。

アプリ画面から送信した返信は送信時点で `OUTBOUND` として保存される。後続のGmail取込では `gmail_message_id` により二重登録を防止する。

## 8. 過去データの再判定

以前の実装で誤った `direction` が保存されている場合は、`reclassifyInquiryMessageDirections()` を一度実行して補正する。

再判定では現在の以下を使用する。

- `INTERNAL_MAIL_DOMAINS`
- 有効な `Members.email`
- 問い合わせ受付アドレス

`InquiryMessages.from_email` が自社側なら `OUTBOUND`、それ以外は `INBOUND` とする。

この処理はメール本文・Gmail ID・問い合わせ紐付けを変更せず、`direction` だけを補正する。

## 9. 未特定再判定

「未特定を再判定」では、補正済みの `InquiryMessages` のうち最新の `INBOUND` の `from_email` を利用する。

`OUTBOUND` は再判定対象の送信元として利用しない。
