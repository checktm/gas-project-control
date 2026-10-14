const APP_CONFIG = {
  appName: 'Project Control',
  spreadsheetId: '1lmiGLeTsT6RRPG4N_hucomsA9PMlUgeljQdffL6GbYY'
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
