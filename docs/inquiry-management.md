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

以下はv0.1では対象外とする。

- 管理画面からのメール返信送信
- AIによる要約・分類・優先度判定
- SLA自動計算
- 高度な重複問い合わせ統合
- 外部顧客向けポータル

## 2. 基本概念

データの基本関係は以下とする。

```text
Customer
  └─ CustomerContact
       └─ Inquiry
            └─ InquiryMessage
```

- Customer: 顧客会社・組織
- CustomerContact: 顧客側の担当者
- Inquiry: 問い合わせ案件
- InquiryMessage: 問い合わせに含まれる個々のメール

メール1通を問い合わせ1件として固定しない。
同一メールスレッドに属する複数メールは、原則として1件のInquiry配下に複数のInquiryMessageとして保持する。

## 3. メール取得

### 3.1 対象

特定の問い合わせ受付用メールアドレス宛に届いたメールを対象とする。

実際の取得条件は運用環境確定時に設定する。

想定例:

- 宛先アドレス一致
- Gmailラベル一致
- Gmail検索条件一致

### 3.2 実行方法

GASの時間主導トリガーで定期実行する。

初期候補は5分間隔とするが、GASの実行制限・運用頻度を確認して最終決定する。

### 3.3 二重取込防止

GmailのメッセージIDを `InquiryMessages.gmail_message_id` に保持し、既に同一IDが登録済みの場合は再取込しない。

同一スレッド判定にはGmailのスレッドIDを使用する。

## 4. 顧客・担当者判定

送信元メールアドレスを正規化したうえで以下の順で判定する。

### 4.1 担当者メールアドレス完全一致

`CustomerContacts.email` と送信元メールアドレスが一致する場合、そのContactとCustomerを自動設定する。

これは最優先の判定とする。

### 4.2 顧客ドメイン一致

担当者メールアドレスが未登録の場合、送信元メールアドレスのドメインと `Customers.domain` を比較する。

一意に一致した場合:

- Customerを自動設定する
- CustomerContactは未確定として扱う
- 必要に応じて後から担当者登録できるようにする

v0.1では、ドメイン一致のみを根拠にCustomerContactを自動で正式登録しない。

### 4.3 判定不能

メールアドレス・ドメインともに一致しない場合:

- Inquiryは登録する
- customer_id は未設定を許可する
- contact_id は未設定とする
- `customer_match_status = UNMATCHED` とする

管理画面から後で顧客を指定できる構造とする。

### 4.4 複数候補

同一ドメインが複数Customerに登録されているなど、一意に特定できない場合は自動確定しない。

`customer_match_status = AMBIGUOUS` として登録し、利用者が選択する。

## 5. 問い合わせ単位の判定

### 5.1 新規問い合わせ

取得したメールのGmail thread IDに紐づく既存Inquiryがない場合、新しいInquiryを作成する。

### 5.2 既存問い合わせへの追加

同じGmail thread IDに紐づくInquiryがある場合、そのInquiryに新しいInquiryMessageを追加する。

### 5.3 件名について

件名文字列のみでは同一問い合わせ判定を行わない。

`Re:` や件名の一致だけで問い合わせを統合すると誤結合の可能性があるため、v0.1ではGmail thread IDを主判定キーとする。

## 6. Customers

想定列:

| 項目 | 内容 |
|---|---|
| customer_id | 一意な顧客ID |
| customer_name | 顧客名 |
| domain | メールドメイン。自動判定用 |
| status | ACTIVE / INACTIVE |
| note | 備考 |
| updated_at | 最終更新日時 |

### 6.1 domain

- `example.co.jp` の形式で保持する
- `@` は含めない
- 小文字へ正規化して比較する
- 空欄を許容する

同一ドメインを複数Customerに設定すること自体は許容するが、その場合は自動顧客確定を行わない。

## 7. CustomerContacts

想定列:

| 項目 | 内容 |
|---|---|
| contact_id | 一意な担当者ID |
| customer_id | Customer参照 |
| contact_name | 担当者名 |
| email | メールアドレス |
| phone | 電話番号 |
| active | 利用状態 |
| updated_at | 最終更新日時 |

### 7.1 email

- 小文字へ正規化して照合する
- 前後空白を除去する
- 原則として一意に扱う

## 8. Inquiries

想定列:

| 項目 | 内容 |
|---|---|
| inquiry_id | 一意な問い合わせID |
| customer_id | 顧客ID。未特定時は空欄可 |
| contact_id | 顧客担当者ID。未特定時は空欄可 |
| gmail_thread_id | GmailスレッドID |
| subject | 問い合わせ件名 |
| status | 問い合わせ状態 |
| priority | 優先度 |
| assigned_member_id | 自社担当者 |
| category | 問い合わせ分類 |
| summary | 問い合わせ概要 |
| next_action | 次回対応 |
| due_date | 対応期限 |
| customer_match_status | 顧客判定状態 |
| received_at | 初回受信日時 |
| last_message_at | 最終メール日時 |
| updated_at | 最終更新日時 |

### 8.1 status

v0.1では以下を候補とする。

- NEW
- IN_PROGRESS
- WAITING_CUSTOMER
- RESOLVED
- CLOSED

画面表示時は日本語表示してよいが、保存値は安定したコード値を優先する。

### 8.2 priority

v0.1では以下とする。

- HIGH
- MEDIUM
- LOW

初期登録時は `MEDIUM` を基本とし、自動優先度判定は行わない。

### 8.3 customer_match_status

以下を保持する。

- EXACT_CONTACT: CustomerContact.email完全一致
- DOMAIN_MATCH: Customer.domain一意一致
- AMBIGUOUS: 複数候補
- UNMATCHED: 候補なし
- MANUAL: 利用者が手動設定済み

## 9. InquiryMessages

想定列:

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

### 9.1 本文

v0.1ではメール本文を保存する。

HTMLメールについては、画面表示・検索・将来の要約処理を考慮し、初期実装ではプレーンテキストとして扱える内容を優先する。

添付ファイル管理はv0.1対象外とする。

## 10. MailImportState

二重取込防止の主キーは `InquiryMessages.gmail_message_id` とするため、必ずしも別シートを必要としない。

ただし以下の運用情報を保持する必要が出た場合は `MailImportState` を追加する。

- 最終取得日時
- 前回実行結果
- 最終正常終了日時
- エラー内容

初期実装時に、Settingsで十分かを判断する。

## 11. 取込処理フロー

```text
定期トリガー
  ↓
対象メール検索
  ↓
Gmail message IDが登録済みか確認
  ├─ Yes → スキップ
  └─ No
       ↓
送信元メールアドレス正規化
       ↓
CustomerContact.email完全一致
  ├─ 一致 → 顧客・担当者確定
  └─ 不一致
       ↓
Customer.domain照合
  ├─ 一意一致 → 顧客候補確定
  ├─ 複数一致 → AMBIGUOUS
  └─ 一致なし → UNMATCHED
       ↓
Gmail thread IDで既存Inquiry検索
  ├─ あり → InquiryMessage追加
  └─ なし → Inquiry作成 + InquiryMessage追加
```

## 12. UI v0.1

問い合わせ一覧を基本画面とする。

最低限表示する項目:

- 受信日時
- 顧客名
- 顧客担当者
- 件名
- 自社担当者
- ステータス
- 優先度
- 対応期限
- 顧客未特定表示

行選択時に、同一画面右側の詳細領域で以下を表示・編集できる構成を優先する。

- 問い合わせ基本情報
- 顧客・担当者
- メール履歴
- ステータス
- 優先度
- 自社担当者
- 次回対応
- 対応期限

## 13. プロジェクト管理との連携

v0.1では問い合わせとProject / Taskを直接必須連携しない。

将来的には以下を可能にする。

```text
Inquiry
  ↓ 必要に応じて
Issue / Risk
  ↓
Task
  ↓
Project
```

問い合わせすべてをプロジェクトタスク化しないことを前提とする。

## 14. エラー時の扱い

メール取込途中でエラーになった場合、同一メールを「取込済み」と誤認しないことを優先する。

少なくとも以下を満たす。

- Gmail message IDの登録完了前に処理成功扱いにしない
- 顧客判定不能はエラーではなく正常な未特定状態として登録する
- 一部メールの異常により全メール取込が恒久停止しない設計を優先する
- エラー内容を後から確認可能にする

## 15. v0.1 実装順序

1. Customers / CustomerContacts / Inquiries / InquiryMessages のデータ構造作成
2. メール取得処理
3. 二重取込防止
4. 顧客・担当者判定
5. Inquiry / InquiryMessage登録
6. 問い合わせ一覧表示
7. 詳細・手動顧客修正

## 16. 実装前に確定する事項

1. 取得対象メールアドレス
2. 対象アドレスの実体がGmail、Workspaceユーザー、エイリアス、Google Group、転送のどれか
3. メール検索条件
4. 取込間隔
5. 自社から送信した返信メールも履歴取得するか
6. 既存顧客マスタがあるか
7. 問い合わせステータス名称の最終確定
8. 添付ファイルを将来扱う必要性
