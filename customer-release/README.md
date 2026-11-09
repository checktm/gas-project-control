# 顧客向け統合ソース（GitHubから直接コピー）

このフォルダの4ファイルは、開発用 `src/` を変更するたびにGitHub Actionsが自動生成します。ZIPのダウンロードは不要です。

| ファイル | 顧客Apps Scriptでの作業 |
|---|---|
| [Index.html](Index.html) | 既存Index.htmlの内容を置き換える |
| [CustomerBackend.gs](CustomerBackend.gs) | 新規作成／以降は置き換える |
| [CustomerStyles.html](CustomerStyles.html) | 新規作成／以降は置き換える |
| [CustomerScripts.html](CustomerScripts.html) | 新規作成／以降は置き換える |

## 初回切替（旧ソースが途中まで反映済みの場合）

1. 顧客Apps Scriptプロジェクトとスプレッドシートをバックアップする。
2. 上記4ファイルを登録し、`Index.html`を置き換える。
3. **旧個別 `.gs` ファイル（`Code.gs`、`DeploymentSecrets.gs`以外）は削除する。** `CustomerBackend.gs`と共存するとグローバル宣言が重複する。
4. `Code.gs`の顧客Spreadsheet IDと`DeploymentSecrets.gs`のAPIキーを保持する。顧客環境の`appsscript.json`（OAuthスコープ・公開設定）も無条件に上書きしない。
5. 旧個別HTMLファイルはまず残してもよい（新しいIndexでは参照しない）。
6. 顧客のステージング/複製GASで画面、メール取得・返信、設定、トリガー、初期化処理を検証してから本番の既存デプロイを更新する。

## 2回目以降

このフォルダにあるファイルを更新するだけでよい。基本は3つの統合ファイル、必要に応じてIndex.htmlも更新する。

**注意：** これは手動コピー用の配布物です。GitHubフォルダから顧客GASへ自動反映はしません。ユーザマスタの全API認可・Workspace本人識別検証はまだ完了しておらず、統合ソースを使うだけでアクセス制限が完成するわけではありません。

生成元: [scripts/build_compact_customer.py](../scripts/build_compact_customer.py) / [更新Workflow](../.github/workflows/update-customer-release.yml)
