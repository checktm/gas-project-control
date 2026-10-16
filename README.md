# gas-project-control

Google Apps Script（GAS）とGoogleスプレッドシートを使った軽量な業務管理Webアプリです。
問い合わせ管理を先行実装し、進捗管理などの業務機能を段階的に追加します。

## 想定構成

- フロントエンド: HTML / CSS / JavaScript（GAS HTML Service）
- バックエンド: Google Apps Script
- データ保存: Googleスプレッドシート
- バージョン管理: GitHub

## デプロイ環境

同一の `src/` を、開発環境と顧客本番環境へ分けてデプロイする。

### Development

`main` の `src/**` などが更新されると、GitHub Actions の `Deploy Development` が自動実行される。

処理内容:

1. 開発用Spreadsheet IDをソースへ注入
2. `clasp push --force` でApps Scriptソースを更新
3. Apps Scriptの新しいVersionを作成
4. 既存の開発WebアプリDeploymentをそのVersionへ更新

これにより、開発Webアプリの `/exec` URLを変えずに最新コードへ自動更新する。
手動 `workflow_dispatch` は障害時の再実行用として残す。

開発環境で必要なSecrets:

- `GAS_CLIENT_ID`
- `GAS_CLIENT_SECRET`
- `GAS_REFRESH_TOKEN`
- `DEV_GAS_DEPLOYMENT_ID`

OAuth Refresh Tokenには少なくとも以下のApps Script APIスコープが必要:

- `https://www.googleapis.com/auth/script.projects`
- `https://www.googleapis.com/auth/script.deployments`

`DEV_GAS_DEPLOYMENT_ID` は Apps Script の「デプロイ > デプロイを管理」で、開発用WebアプリのDeployment IDを確認して登録する。

開発用の `.clasp.json` はリポジトリに保持する。

### Production（OAuthデプロイ可能な環境）

GitHub Actions の `Deploy Production` は手動実行する。
本番用の識別子・認証情報はリポジトリへ保存せず、GitHub Secretsのみで管理する。

必要なSecrets:

- `PROD_GAS_CLIENT_ID`
- `PROD_GAS_CLIENT_SECRET`
- `PROD_GAS_REFRESH_TOKEN`
- `PROD_GAS_SCRIPT_ID`
- `PROD_SPREADSHEET_ID`
- `PROD_GEMINI_API_KEY`

1つでも未設定の場合、本番デプロイは停止する。

現時点の本番WorkflowはApps Scriptソース更新までを対象とする。WebアプリVersion/Deployment更新の自動化は、開発環境での運用確認後に適用する。

### 顧客環境（外部OAuthアプリを許可できない場合）

顧客Google Workspaceのポリシーにより外部OAuthアプリを承認できない場合、CONTOUR側から顧客Apps Scriptへ直接 `clasp push` しない。

GitHub Actions の `Build Customer Package` を手動実行し、顧客向けリリースZIPを生成する。

顧客側で必要なもの:

1. 顧客Googleアカウント所有のApps Scriptプロジェクト
2. 顧客Google Drive内の管理用Spreadsheet
3. 顧客アカウントでApps Scriptの必要権限を承認できること

不要なもの:

- 顧客側Google Cloud Projectの新規作成
- CONTOUR外部OAuthアプリの承認
- 顧客PCへのNode.js / clasp / Gitの常設インストール

初回構築では、ZIP内のソースをApps Scriptへ登録後、`Code.gs` に顧客Spreadsheet IDを設定し、`setupCustomerEnvironment()` を1回実行する。

この関数は問い合わせ管理に必要なシートと初期Settingsを不足分だけ作成し、既存データは削除・上書きしない。

詳細な手順は `docs/customer-installation.md` を正本とする。

### 環境固有設定

`src/Code.gs` のSpreadsheet IDはリポジトリへ固定せず、`__SPREADSHEET_ID__` を環境ごとに設定する。

GitHub Actions経由の環境ではデプロイ時に自動置換し、外部OAuthを使わない顧客環境ではApps Scriptへ登録後に顧客Spreadsheet IDへ手動設定する。

顧客向けパッケージではGemini APIキーを埋め込まず、空欄で配布する。AI要約は初期状態では無効とし、APIキーの所有者・利用料・秘密情報管理方針を決めた後に有効化する。

## 開発方針

詳細は `prompts/main.md` を参照してください。
要件の正本は `docs/requirements.md` とし、仕様変更時は関連ドキュメントも更新します。
