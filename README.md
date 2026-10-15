# gas-project-control

PM向けのプロジェクト進捗管理資料を、Google Apps Script（GAS）とGoogleスプレッドシートを使ったWebアプリとして運用するためのリポジトリです。

## 目的

- PMが進捗状況を一画面で把握できること
- タスク、工程、担当者、期限、進捗率、課題、リスクを一元管理できること
- ガントチャートや期限超過・遅延の可視化を行えること
- 進捗会議でそのまま利用できる情報を整理できること
- 既存の進捗管理資料を置き換えつつ、入力負荷を増やさないこと

## 想定構成

- フロントエンド: HTML / CSS / JavaScript（GAS HTML Service）
- バックエンド: Google Apps Script
- データ保存: Googleスプレッドシート
- バージョン管理: GitHub

## 初期スコープ

1. プロジェクト／案件の管理
2. 工程・タスクの管理
3. 担当者の管理
4. 計画開始日・終了日、実績開始日・終了日の管理
5. 進捗率・ステータス管理
6. 課題・リスク・次回アクション・PMコメント管理
7. ガントチャート表示
8. 遅延・期限超過の強調表示
9. プロジェクト全体の進捗サマリー

## デプロイ環境

同一の `src/` を、開発環境と顧客本番環境へ分けてデプロイする。

### Development

GitHub Actions の `Deploy Development` を手動実行する。

- Apps Script: 現在の開発用GAS
- Spreadsheet: 開発用 `gas-project-control`
- OAuth Secrets:
  - `GAS_CLIENT_ID`
  - `GAS_CLIENT_SECRET`
  - `GAS_REFRESH_TOKEN`

開発用の `.clasp.json` はリポジトリに保持する。

### Production

GitHub Actions の `Deploy Production` を手動実行する。
本番用の識別子・認証情報はリポジトリへ保存せず、GitHub Secretsのみで管理する。

必要なSecrets:

- `PROD_GAS_CLIENT_ID`
- `PROD_GAS_CLIENT_SECRET`
- `PROD_GAS_REFRESH_TOKEN`
- `PROD_GAS_SCRIPT_ID`
- `PROD_SPREADSHEET_ID`

1つでも未設定の場合、本番デプロイは停止する。

### 環境固有設定

`src/Code.gs` のSpreadsheet IDはソースへ固定せず、`__SPREADSHEET_ID__` をデプロイ時に対象環境のIDへ置換する。

本番の `.clasp.json` もGitHub Actions実行時に `PROD_GAS_SCRIPT_ID` から生成する。
これにより、GitHub上の共通ソースを変更せずに、開発環境と顧客環境を分離できる。

### 顧客環境へ移行するとき

顧客側で以下を用意する。

1. 顧客Googleアカウント所有のApps Scriptプロジェクト
2. 顧客Google Drive内の管理用Spreadsheet
3. 顧客側Google Cloud OAuthクライアント
4. 顧客Googleアカウントで取得したRefresh Token
5. 上記5つの `PROD_*` SecretsをGitHubへ登録

顧客PCへのNode.js / clasp / Gitの常設インストールは不要とし、デプロイ処理はGitHub Actions上で実行する。

## 開発方針

詳細は `prompts/main.md` を参照してください。
要件の正本は `docs/requirements.md` とし、仕様変更時は関連ドキュメントも更新します。
