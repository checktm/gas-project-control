# 顧客環境構築手順（外部OAuth不要方式）

## 1. 方針

顧客Google Workspaceで外部OAuthアプリを承認できない場合は、CONTOUR側から顧客Apps Scriptへ直接デプロイしない。

顧客環境では次の構成で運用する。

```text
CONTOUR
- GitHubでソース管理
- 開発・検証
- 顧客向けリリースZIPを生成

顧客Google Workspace
- Spreadsheet
- Apps Script
- Gmail
- Webアプリ
```

Apps Scriptの実行・権限承認・トリガー・WebアプリDeploymentは顧客Googleアカウントで行う。

## 2. 顧客側で必要なもの

- Google Workspaceアカウント
- Google DriveでSpreadsheetを作成できる権限
- Apps Scriptプロジェクトを作成・編集できる権限
- Gmailを利用できる権限
- Apps Scriptの必要権限を本人が承認できること

Google Cloud Projectの新規作成、外部OAuthアプリの承認、顧客PCへのNode.js / clasp / Gitの常設インストールは不要。

## 3. 初回構築

### 3.1 Spreadsheetを作成

顧客Google Driveで本番用Spreadsheetを1つ作成し、URLからSpreadsheet IDを控える。

例:

```text
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
```

### 3.2 Apps Scriptプロジェクトを作成

顧客Googleアカウントで新しいApps Scriptプロジェクトを作成する。

### 3.3 顧客向けリリースZIPを取得

GitHub Actionsの `Build Customer Package` を実行し、生成されたArtifactをダウンロードする。

ZIP内の `src/` にApps Scriptへ登録するファイル一式が入る。

### 3.4 ソースをApps Scriptへ登録

Apps ScriptエディタでZIP内の `src/` と同じファイル名を作成し、内容を貼り付ける。

`appsscript.json` はApps Scriptエディタのプロジェクト設定でマニフェストファイル表示を有効にして更新する。

### 3.5 Spreadsheet IDを設定

`Code.gs` の次の値を顧客Spreadsheet IDへ変更する。

```javascript
spreadsheetId: '__SPREADSHEET_ID__'
```

例:

```javascript
spreadsheetId: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

`buildSha` / `buildTime` のプレースホルダーは手動導入ではそのままでも動作に影響しない。

### 3.6 初期化を実行

Apps Scriptエディタで `setupCustomerEnvironment()` を1回実行する。

初回はGoogleの権限承認画面が表示されるため、顧客Googleアカウントで承認する。

この処理は以下を行う。

- 必要なシートを不足分だけ作成
- 必須ヘッダーを確認
- 初期Settingsを不足分だけ追加
- 既存データは削除・上書きしない

対象シート:

- Members
- Settings
- Customers
- CustomerContacts
- Inquiries
- InquiryMessages
- InquiryCategories

## 4. 問い合わせ設定

Webアプリのマスタ管理、またはSpreadsheetの `Settings` で設定する。

最低限必要な設定:

| key | 内容 |
|---|---|
| INQUIRY_GROUP_ADDRESS | 問い合わせ受付アドレス。複数ある場合はカンマ、改行、セミコロン区切り |
| INTERNAL_MAIL_DOMAINS | 自社メールドメイン。複数ある場合はカンマ、改行、セミコロン区切り |
| MAIL_SEARCH_QUERY | Gmail検索条件 |
| MAIL_IMPORT_MAX_THREADS | 1回の最大検索スレッド数 |
| MAIL_IMPORT_ENABLED | 自動取込を有効にする場合TRUE |

自社の個別メールアドレスはSettingsへ重複登録しない。有効な `Members.email` と問い合わせ受付アドレスを方向判定へ自動利用する。

`INQUIRY_GROUP_ADDRESS` は既存key名を維持しているが、値は複数登録できる。例:

```text
support@example.co.jp, sales@example.co.jp
```

既存の `MAIL_SEARCH_QUERY=to:{GROUP_ADDRESS} newer_than:30d` は複数受付時に各受付アドレスへのOR検索へ自動展開される。

初期化時は誤取込防止のため `MAIL_IMPORT_ENABLED=FALSE` とする。

## 5. Gmail取込トリガー

問い合わせ設定確認後、`MAIL_IMPORT_ENABLED` を `TRUE` に変更する。

Apps Scriptエディタで `installInquiryMailImportTrigger()` を1回実行する。

これにより、実行した顧客Googleアカウント所有の5分間隔トリガーが作成される。

トリガーはCONTOURアカウントではなく顧客アカウントで作成する。

既存メールの受信・送信判定を補正する必要がある場合は、設定と社内メンバー登録後に `reclassifyInquiryMessageDirections()` を一度実行する。

## 6. Webアプリとしてデプロイ

Apps Scriptで次を実行する。

1. `デプロイ`
2. `新しいデプロイ`
3. 種類: `ウェブアプリ`
4. 実行ユーザー: 運用方針に従い顧客側の運用アカウント
5. アクセス範囲: 必要最小限
6. デプロイ

表示された `/exec` URLを本番URLとして使用する。

## 7. AI要約

顧客環境の初期値は `GEMINI_AI_ENABLED=FALSE` とする。

理由:

- 外部OAuthを使わない方式とGemini APIキー管理は別問題である
- 顧客所有Apps ScriptへAPIキーを直接埋め込むと、Apps Script編集権限を持つ顧客ユーザーからキーを確認できる

AI要約を有効化する場合は、APIキーの所有者・利用料・秘密情報管理方針を別途決めてから設定する。

## 8. バージョンアップ

外部OAuthを使わないため、CONTOURから顧客Apps Scriptへの自動pushは行わない。

更新手順:

1. CONTOURで新バージョンを検証
2. `Build Customer Package` から最新ZIPを生成
3. 顧客担当者へZIPと変更内容を提供
4. 顧客Apps Scriptの対象ファイルを差し替える
5. 必要に応じて `setupCustomerEnvironment()` を再実行する
6. Apps Scriptで新しいVersionを作成
7. 既存WebアプリDeploymentを新Versionへ更新
8. `/exec` URLで動作確認

`setupCustomerEnvironment()` は不足シート・不足設定のみ追加し、既存業務データを消さないため、通常のアップデート時にも再実行できる。

## 9. 導入時確認項目

- 顧客Spreadsheet IDが正しい
- Apps Script実行者がSpreadsheetへアクセスできる
- Apps Script実行者が対象Gmailを検索できる
- 問い合わせ受付アドレスがSettingsに設定されている
- 自社メールドメインがSettingsに設定されている
- 社内メンバーのメールアドレスがMembersに登録されている
- `previewInquiryMailCandidates()` で対象メールだけ取得される
- `MAIL_IMPORT_ENABLED=TRUE` にする前に検索条件を確認した
- `installInquiryMailImportTrigger()` を顧客アカウントで実行した
- Webアプリから問い合わせ一覧が表示できる
- テスト問い合わせへの返信が同じGmailスレッドに残る
- モバイル表示を確認した
