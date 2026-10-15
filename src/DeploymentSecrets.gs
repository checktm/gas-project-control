/**
 * デプロイ時にGitHub Actionsが環境別Secretを注入する。
 * リポジトリ上ではプレースホルダーのみを保持し、実値をコミットしない。
 */
const DEPLOYMENT_SECRETS = Object.freeze({
  geminiApiKey: '__GEMINI_API_KEY__'
});
