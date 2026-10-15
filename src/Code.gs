const APP_CONFIG = {
  appName: 'Project Control',
  // デプロイ時にGitHub Actionsが対象環境のSpreadsheet IDへ置換する。
  spreadsheetId: '__SPREADSHEET_ID__'
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
