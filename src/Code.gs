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
