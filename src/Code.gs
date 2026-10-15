const APP_CONFIG = {
  appName: 'Project Control',
  // デプロイ時にGitHub Actionsが対象環境の値へ置換する。
  spreadsheetId: '__SPREADSHEET_ID__',
  buildSha: '__BUILD_SHA__',
  buildTime: '__BUILD_TIME__'
};

function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.appConfig = APP_CONFIG;

  return template
    .evaluate()
    .setTitle(APP_CONFIG.appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getAppConfig() {
  return APP_CONFIG;
}

/**
 * 初回セットアップ用。
 * Gemini APIで使う UrlFetchApp の権限承認を明示的に発生させる。
 * 外部サービスへ業務データやAPIキーは送らない。
 */
function authorizeExternalRequest() {
  const response = UrlFetchApp.fetch('https://www.google.com/generate_204', {
    method: 'get',
    muteHttpExceptions: true
  });
  return response.getResponseCode();
}
