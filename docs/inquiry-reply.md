# 問い合わせ返信機能

## 1. 目的

問い合わせ管理画面から、顧客の受信メールへ直接返信できるようにする。

本機能は `docs/inquiry-management.md` の v0.1 に対する追加機能として扱う。既存の問い合わせ・メール履歴構造は変更せず、`InquiryMessages.direction = OUTBOUND` を利用して送信履歴を保持する。

## 2. 基本方針

- 新規メール送信ではなく、対象問い合わせに紐づく最新の受信メールへ返信する。
- Gmail上でも元のスレッドを維持する。
- 件名文字列だけを使ってスレッドを再現しない。
- 返信先は最新受信メールの Reply-To を優先し、なければ送信元を利用する。
- 送信前に画面で宛先と確認ダイアログを表示する。
- 送信後は `InquiryMessages` に `OUTBOUND` として即時記録する。
- 返信送信だけでは問い合わせステータスを自動変更しない。
- 添付、CC/BCC、HTML編集は初期対象外とする。

## 3. 返信対象の決定

対象問い合わせの `InquiryMessages` から、以下を満たす最新行を使用する。

- `inquiry_id` が対象問い合わせと一致
- `direction = INBOUND`
- `gmail_message_id` が存在する

この `gmail_message_id` から `GmailApp.getMessageById()` で元メールを取得し、`GmailMessage.reply(body)` を実行する。

これにより Gmail の Reply-To と元スレッドを利用する。

## 4. UI

問い合わせ詳細のメール履歴上部に返信領域を表示する。

表示項目:

- 返信先
- 返信本文
- 送信状態
- `返信を送信` ボタン

送信時は確認ダイアログを表示し、利用者が確認した場合のみ送信する。

空本文では送信できない。

## 5. 送信後の記録

送信成功後、`InquiryMessages` に以下を記録する。

- `message_id`: 新規システムID
- `inquiry_id`: 対象問い合わせID
- `gmail_message_id`: Gmail側で取得できた送信メッセージID
- `gmail_thread_id`: 元スレッドID
- `direction`: `OUTBOUND`
- `from_email`: 実際の送信元
- `to_email`: 実際の宛先
- `subject`: Gmail上の件名
- `body`: 送信本文
- `sent_at`: 送信日時
- `imported_at`: 記録日時

送信直後にGmail側の新しいメッセージを取得できない場合でも、メール送信自体を失敗扱いにして再送を誘発しない。取得可能な項目で履歴を記録する。

## 6. 問い合わせ更新

返信送信時に `Inquiries.last_message_at` と `updated_at` を更新する。

`status` は自動変更しない。`WAITING_CUSTOMER` への変更を自動化する場合は、実運用確認後に別仕様として追加する。

## 7. 権限

Apps Script の Gmail操作には `https://mail.google.com/` OAuth Scopeを使用する。

既存アプリはメール取込のため同Scopeを利用しているため、返信機能用の追加Scopeは不要。

## 8. 初期対象外

- 添付ファイル
- CC / BCC
- HTMLリッチテキスト編集
- 返信テンプレート
- Geminiによる返信文案生成
- 送信予約
- 承認ワークフロー
- ステータス自動変更
