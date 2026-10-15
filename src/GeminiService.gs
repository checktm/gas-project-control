/**
 * Gemini API を利用したテキスト生成サービス。
 * APIキーはGitHub ActionsがDeploymentSecrets.gsへ注入する。
 */
function generateGeminiText_(prompt, model) {
  return generateGeminiTextWithMeta_(prompt, model).text;
}

/**
 * 一時的な混雑・障害時は同一モデルを指数バックオフで再試行し、
 * それでも失敗した場合のみ軽量モデルへフォールバックする。
 */
function generateGeminiTextWithMeta_(prompt, model, fallbackModel) {
  const apiKey = getGeminiApiKey_();
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません。');

  const primaryModel = String(model || '').trim();
  if (!primaryModel) throw new Error('Geminiモデルが設定されていません。');

  const secondaryModel = String(fallbackModel || 'gemini-3.5-flash-lite').trim();
  const primaryResult = callGeminiWithRetry_(prompt, primaryModel, apiKey);
  if (primaryResult.ok) {
    return { text: primaryResult.text, model: primaryModel, fallbackUsed: false };
  }

  // 認証・入力不正など、再試行しても改善しないエラーはフォールバックしない。
  if (!primaryResult.transient) {
    throwGeminiFailure_(primaryResult);
  }

  // 同じモデル名なら二重実行しない。
  if (!secondaryModel || secondaryModel === primaryModel) {
    throwGeminiFailure_(primaryResult);
  }

  console.warn('Gemini primary model unavailable after retries. Fallback to ' + secondaryModel + '.');
  const fallbackResult = callGeminiWithRetry_(prompt, secondaryModel, apiKey);
  if (fallbackResult.ok) {
    return { text: fallbackResult.text, model: secondaryModel, fallbackUsed: true };
  }

  throw new Error(
    'Gemini APIが一時的に混雑しています。主モデルと代替モデルの両方で生成できませんでした。' +
    ' 少し時間をおいて再実行してください。'
  );
}

function callGeminiWithRetry_(prompt, modelName, apiKey) {
  const waitMs = [0, 1000, 2000, 4000];
  let lastResult = null;

  for (let attempt = 0; attempt < waitMs.length; attempt += 1) {
    if (waitMs[attempt] > 0) Utilities.sleep(waitMs[attempt]);

    const result = callGeminiOnce_(prompt, modelName, apiKey);
    if (result.ok) return result;

    lastResult = result;
    if (!result.transient) return result;

    console.warn(
      'Gemini temporary failure. model=' + modelName +
      ' attempt=' + (attempt + 1) + '/' + waitMs.length +
      ' status=' + result.status
    );
  }

  return lastResult || {
    ok: false,
    transient: true,
    status: 0,
    detail: 'Gemini APIへの接続に失敗しました。'
  };
}

function callGeminiOnce_(prompt, modelName, apiKey) {
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
    return {
      ok: false,
      transient: true,
      status: 0,
      detail: 'Gemini APIへの接続に失敗しました。' + (error && error.message ? ' ' + error.message : '')
    };
  }

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status < 200 || status >= 300) {
    let detail = '';
    try {
      const parsedError = JSON.parse(body);
      detail = parsedError && parsedError.error && parsedError.error.message ? parsedError.error.message : '';
    } catch (ignore) {}

    return {
      ok: false,
      transient: isTransientGeminiStatus_(status),
      status: status,
      detail: detail
    };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      transient: false,
      status: status,
      detail: 'Gemini APIの応答を解析できませんでした。'
    };
  }

  const candidates = data && data.candidates;
  const parts = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts;
  const text = Array.isArray(parts)
    ? parts.map(function(part) { return part && part.text ? String(part.text) : ''; }).join('\n').trim()
    : '';

  if (!text) {
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    return {
      ok: false,
      transient: false,
      status: status,
      detail: blocked ? 'Geminiが要約生成を停止しました。理由: ' + blocked : 'Geminiから要約文が返されませんでした。'
    };
  }

  return { ok: true, text: text, status: status, transient: false };
}

function isTransientGeminiStatus_(status) {
  return [429, 500, 502, 503, 504].indexOf(Number(status)) >= 0;
}

function throwGeminiFailure_(result) {
  const status = Number(result && result.status || 0);
  const detail = String(result && result.detail || '').trim();

  if (status === 429) {
    throw new Error('Gemini APIの利用上限または一時的な混雑により処理できませんでした。少し時間をおいて再実行してください。');
  }
  if (status === 503) {
    throw new Error('Gemini APIが一時的に混雑しています。少し時間をおいて再実行してください。');
  }
  if (!status) {
    throw new Error(detail || 'Gemini APIへの接続に失敗しました。');
  }
  throw new Error('Gemini APIでエラーが発生しました。HTTP ' + status + (detail ? ' / ' + detail : ''));
}

function getGeminiApiKey_() {
  const injected = typeof DEPLOYMENT_SECRETS !== 'undefined'
    ? String(DEPLOYMENT_SECRETS.geminiApiKey || '').trim()
    : '';
  if (injected && injected !== '__GEMINI_API_KEY__') return injected;

  // 既存環境の移行用フォールバック。新規運用ではGitHub Secretを正本とする。
  return String(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '').trim();
}
