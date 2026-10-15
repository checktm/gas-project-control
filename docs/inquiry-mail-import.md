# Googleグループ問い合わせメール取込仕様 v0.1

## 1. 前提

問い合わせ受付アドレスはGoogleグループとする。

GASはGoogleグループそのものを直接読み取らず、Googleグループのメンバーである実行ユーザーのGmailへ配信されたメールを取得する。

実行ユーザーがGoogleグループの「メッセージごとにメール」を受信できることを前提とする。

## 2. 設定

メール取込条件はソースコードへ固定せず、`Settings` シートで管理する。

| setting_key | 初期値 | 内容 |
|---|---|---|
| INQUIRY_GROUP_ADDRESS | 空欄 | 問い合わせ受付用Googleグループアドレス |
| MAIL_SEARCH_QUERY | `to:{GROUP_ADDRESS} newer_than:30d` | Gmail検索条件。`{GROUP_ADDRESS}` を実アドレスへ置換して実行 |
| MAIL_IMPORT_MAX_THREADS | `50` | 1回の検索上限スレッド数 |
| MAIL_IMPORT_ENABLED | `FALSE` | `TRUE` の場合のみ自動取込を許可 |

実アドレス確認前は `MAIL_IMPORT_ENABLED = FALSE` とし、誤取込を防止する。

## 3. 実環境確認手順

実際のGoogleグループアドレスを設定後、最初に `previewInquiryMailCandidates()` を手動実行する。

この処理はスプレッドシートを更新せず、以下を確認するためだけに利用する。

- Gmail検索条件で対象スレッドが取得できるか
- `To` または `Cc` にGoogleグループアドレスが残っているか
- 送信者・件名・日時が期待どおり取得できるか

`to:` で取得できない場合は、実メールの配送状態を確認し、`MAIL_SEARCH_QUERY` を変更する。検索条件の変更だけで対応できない場合は、メッセージ単位の対象判定ロジックを見直す。

## 4. 自動取込

`importInquiryEmails()` が取込処理本体である。

処理順序は以下とする。

```text
Settings確認
  ↓
MAIL_IMPORT_ENABLED = TRUE を確認
  ↓
Gmail検索
  ↓
スレッド内メッセージを個別確認
  ↓
Googleグループ宛メッセージだけ抽出
  ↓
Gmail message IDで二重取込判定
  ↓
送信者メールアドレス正規化
  ↓
CustomerContact完全一致
  ↓ なければ
Customerドメイン一致
  ↓
Gmail thread IDでInquiryを特定
  ↓
Inquiry / InquiryMessageへ保存
```

Gmail検索はスレッド単位で返るため、検索結果のスレッドに含まれるすべてのメールをそのまま保存しない。v0.1では各メッセージの `To` / `Cc` にGoogleグループアドレスが含まれることを確認し、対象メールだけを保存する。

## 5. 顧客判定

送信者メールアドレスは小文字化し、前後空白を除去して照合する。

優先順位:

1. `CustomerContacts.email` の一意な完全一致 → `EXACT_CONTACT`
2. `Customers.domain` の一意な一致 → `DOMAIN_MATCH`
3. 複数候補 → `AMBIGUOUS`
4. 一致なし → `UNMATCHED`

顧客が特定できなくても問い合わせ登録自体は正常処理とする。

## 6. 二重取込防止

`InquiryMessages.gmail_message_id` を取込済み判定キーとする。

同一Gmail message IDが存在する場合はスキップする。

問い合わせ単位の関連付けには `gmail_thread_id` を利用する。

## 7. 時間主導トリガー

実環境確認完了後、次を行う。

1. `INQUIRY_GROUP_ADDRESS` を設定
2. `previewInquiryMailCandidates()` で確認
3. `MAIL_IMPORT_ENABLED` を `TRUE` に変更
4. `installInquiryMailImportTrigger()` を一度だけ手動実行

`installInquiryMailImportTrigger()` は既存の同一ハンドラートリガーを削除してから、5分間隔のトリガーを1件作成する。

実アドレス未設定または取込無効状態ではトリガーを作成しない。

## 8. v0.1の対象外

- 自社返信メールの自動取込
- 添付ファイル保存
- HTML本文の完全保存
- AI要約・分類
- Googleグループ管理APIによる投稿取得
- 高度なメールヘッダー解析

これらは実運用確認後に必要性を判断する。
