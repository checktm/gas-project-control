/**
 * Gemini API を利用したテキスト生成サービス。
 * APIキーは Script Properties の GEMINI_API_KEY から取得する。
 */
function generateGeminiText_(prompt, model) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません。');

  const modelName = String(model || '').trim();
  if (!modelName) throw new Error('Geminiモデルが設定されていません。');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelName) + ':generateContent';
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(prompt || '') }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 700
    }
  };

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-goog-api-key': apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (error) {
    throw new Error('Gemini APIへの接続に失敗しました。' + (error && error.message ? ' ' + error.message : ''));
  }

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    let detail = '';
    try {
      const parsedError = JSON.parse(body);
      detail = parsedError && parsedError.error && parsedError.error.message ? parsedError.error.message : '';
    } catch (ignore) {}
    if (status === 429) throw new Error('Gemini APIの利用上限に達しました。少し時間をおいて再実行してください。');
    throw new Error('Gemini APIでエラーが発生しました。HTTP ' + status + (detail ? ' / ' + detail : ''));
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error('Gemini APIの応答を解析できませんでした。');
  }

  const candidates = data && data.candidates;
  const parts = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts;
  const text = Array.isArray(parts)
    ? parts.map(function(part) { return part && part.text ? String(part.text) : ''; }).join('\n').trim()
    : '';

  if (!text) {
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(blocked ? 'Geminiが要約生成を停止しました。理由: ' + blocked : 'Geminiから要約文が返されませんでした。');
  }
  return text;
}
