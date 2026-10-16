# 問い合わせ管理仕様 v0.1

## 1. 目的

特定の問い合わせ受付用メールアドレスに届いたメールを自動取得し、送信者から顧客・顧客担当者を特定して、問い合わせとして一元管理する。

本機能は、既存のプロジェクト進捗管理とは独立した業務機能として実装する。ただし将来的には、問い合わせから課題・タスク・プロジェクトへ連携できる構造を持つ。

v0.1では、以下を対象とする。

1. 対象メールの自動取得
2. 未取込メールの判定
3. 送信者メールアドレスによる顧客・担当者判定
4. 問い合わせの登録
5. 問い合わせ一覧表示
6. 問い合わせに紐づくメール履歴の保持
7. 同一Gmailスレッド内で別件が始まった場合の問い合わせ分離
8. 送信元ドメインによる問い合わせ一覧対象外設定

## 2. 基本概念

```text
Customer
  └─ CustomerContact
       └─ Inquiry
            └─ InquiryMessage
```

- Customer: 顧客会社・組織
- CustomerContact: 顧客側の担当者
- Inquiry: 業務上の問い合わせ案件
- InquiryMessage: 問い合わせに含まれる個々のメール

メール1通を問い合わせ1件として固定しない。
Gmailスレッドはメール上の会話単位、Inquiryは業務上の問い合わせ単位として扱う。
通常は同一Gmailスレッドの複数メールを1件のInquiryへ保持するが、同じスレッドで別件が始まった場合は複数Inquiryへ分離できる。

## 3. メール取得と一覧対象

### 3.1 対象メール

特定の問い合わせ受付用メールアドレス宛に届いたメールを対象とする。取得条件は `MAIL_SEARCH_QUERY` 等の設定で管理する。

### 3.2 実行方法

GASの時間主導トリガーで定期実行する。

### 3.3 二重取込防止

GmailのメッセージIDを `InquiryMessages.gmail_message_id` に保持し、既に同一IDが登録済みの場合は再取込しない。

Gmail thread IDはメール会話の追跡に利用するが、Inquiryとの1対1制約にはしない。

### 3.4 問い合わせ一覧対象外ドメイン

`Settings.INQUIRY_EXCLUDED_DOMAINS` に、問い合わせ一覧・ダッシュボードから除外する送信元ドメインを登録できる。

- 複数ドメインをカンマ、改行、セミコロン区切りで指定できる
- `example.com` を指定した場合、`example.com` と `sub.example.com` 等のサブドメインも対象外とする
- 判定にはそのInquiryを開始した最初の受信メールの送信元ドメインを使用する
- 後続メールの送信元が変わっても表示可否は変えない
- 対象外になったInquiry / InquiryMessageは削除しない
- 設定からドメインを外すと再び一覧・ダッシュボードへ表示される
- 問い合わせ一覧件数、ダッシュボード集計、最近の問い合わせも対象外Inquiryを除いて計算する

データを削除せず表示対象から外す方式とし、誤設定時にも元へ戻せることを優先する。

## 4. 顧客・担当者判定

送信元メールアドレスを正規化したうえで以下の順で判定する。

### 4.1 担当者メールアドレス完全一致

`CustomerContacts.email` と送信元メールアドレスが一致する場合、そのContactとCustomerを自動設定する。

### 4.2 顧客ドメイン一致

担当者メールアドレスが未登録の場合、送信元メールアドレスのドメインと `Customers.domain` を比較する。一意に一致した場合はCustomerを設定し、CustomerContactは未確定とする。

### 4.3 判定不能・複数候補

一致しない場合は `UNMATCHED`、複数候補の場合は `AMBIGUOUS` とし、問い合わせ自体は保持する。

## 5. 問い合わせ単位の判定

### 5.1 初回取込

取得したメールのGmail thread IDに紐づくInquiryがない場合、新しいInquiryを作成する。

### 5.2 通常の追加

同じGmail thread IDに紐づくInquiryがある場合、新着メールはそのスレッドで最後に作成されたInquiryへ追加する。

問い合わせ状態だけでは継続・別件を自動判断しない。

### 5.3 別問い合わせへの分離

利用者がメール履歴の受信メールで `別問い合わせ` を選択した場合、そのメールを新しい問い合わせの開始点とする。

- 選択した受信メールと、それより後のメールを新しいInquiryへ移す
- 元のInquiryと新しいInquiryは同じ `gmail_thread_id` を保持してよい
- 元のInquiryは削除せず、それ以前のメール履歴を保持する
- 新しいInquiryは `NEW` / `MEDIUM` で開始する
- 新しいInquiryの顧客・担当者は分離開始メールの送信元から再判定する
- 分離後に同じGmailスレッドへ届く新着メールは、最後に作成されたInquiryへ追加する

最初のメールから分離すると元Inquiryが空になるため許可しない。

### 5.4 件名について

件名文字列のみでは同一問い合わせ・別問い合わせを自動判定しない。

## 6. Customers

| 項目 | 内容 |
|---|---|
| customer_id | 一意な顧客ID |
| customer_name | 顧客名 |
| domain | メールドメイン。自動判定用 |
| status | ACTIVE / INACTIVE |
| note | 備考 |
| updated_at | 最終更新日時 |

## 7. CustomerContacts

| 項目 | 内容 |
|---|---|
| contact_id | 一意な担当者ID |
| customer_id | Customer参照 |
| contact_name | 担当者名 |
| email | メールアドレス |
| phone | 電話番号 |
| active | 利用状態 |
| updated_at | 最終更新日時 |

## 8. Inquiries

| 項目 | 内容 |
|---|---|
| inquiry_id | 一意な問い合わせID |
| customer_id | 顧客ID。未特定時は空欄可 |
| contact_id | 顧客担当者ID。未特定時は空欄可 |
| gmail_thread_id | GmailスレッドID。複数Inquiryで同値を許容 |
| subject | 元メール件名。受信情報として保持 |
| status | 問い合わせ状態 |
| priority | 優先度 |
| assigned_member_id | 自社担当者 |
| category | 問い合わせ分類 |
| summary | 一覧・見出し用の短い概要。初期値はメール件名 |
| detail | 問い合わせの詳細説明 |
| next_action | 次回対応 |
| due_date | 対応期限 |
| customer_match_status | 顧客判定状態 |
| received_at | 初回受信日時 |
| last_message_at | 最終メール日時 |
| updated_at | 最終更新日時 |

### 8.1 status

- NEW
- IN_PROGRESS
- WAITING_CUSTOMER
- RESOLVED
- CLOSED

### 8.2 priority

- HIGH
- MEDIUM
- LOW

### 8.3 概要と詳細

- `summary` は問い合わせ一覧で識別するための短い概要とし、新規作成時はメール件名を初期値にする
- `detail` は問い合わせ内容や経緯を整理する詳細説明とする
- 旧仕様の `summary` に保持していた詳しい内容は、初回マイグレーション時に `detail` へ移す

## 9. InquiryMessages

| 項目 | 内容 |
|---|---|
| message_id | システム内メッセージID |
| inquiry_id | Inquiry参照 |
| gmail_message_id | GmailメッセージID |
| gmail_thread_id | GmailスレッドID |
| direction | INBOUND / OUTBOUND |
| from_email | 送信元 |
| to_email | 宛先 |
| subject | 件名 |
| body | 本文 |
| sent_at | メール日時 |
| imported_at | システム取込日時 |

## 10. Settings

問い合わせ管理で主に使用する設定:

| key | 用途 |
|---|---|
| INQUIRY_GROUP_ADDRESS | 問い合わせ受付アドレス |
| MAIL_SEARCH_QUERY | Gmail検索条件 |
| MAIL_IMPORT_MAX_THREADS | 1回の最大検索スレッド数 |
| MAIL_IMPORT_ENABLED | メール自動取込の有効/無効 |
| INTERNAL_MAIL_DOMAINS | 自社送信判定用ドメイン |
| INQUIRY_EXCLUDED_DOMAINS | 問い合わせ一覧・ダッシュボード対象外ドメイン |

## 11. 取込・表示フロー

```text
メール取込
  ↓
Inquiry / InquiryMessageへ保存
  ↓
問い合わせ画面・ダッシュボード読込
  ↓
INQUIRY_EXCLUDED_DOMAINS と
Inquiry開始元の送信元ドメインを照合
  ├─ 対象外 → 一覧・集計に出さない
  └─ 対象   → 通常表示
```

## 12. UI

問い合わせ一覧では `summary` を主表示し、メール件名は補助情報として表示する。

受信メールには `別問い合わせ` 操作を表示する。

マスタ管理の「システム設定」から `問い合わせ対象外ドメイン` を編集できる。

## 13. エラー時の扱い

- Gmail message IDの登録完了前に処理成功扱いにしない
- 顧客判定不能はエラーではなく正常な未特定状態として登録する
- 問い合わせ分離中はスクリプトロックを取り、メール取込等との競合を避ける
- 対象外ドメイン設定はデータ削除を行わない
