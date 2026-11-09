// --- bundled from CustomerSetup.gs ---
/**
 * 外部OAuthを使わない顧客環境の初期構築用。
 * 必要なシートが存在しない場合だけ作成し、既存データは削除・上書きしない。
 *
 * 実行前に Code.gs の APP_CONFIG.spreadsheetId を顧客Spreadsheet IDへ設定する。
 */
function setupCustomerEnvironment() {
  if (!APP_CONFIG.spreadsheetId || APP_CONFIG.spreadsheetId === '__SPREADSHEET_ID__') {
    throw new Error('Code.gs の APP_CONFIG.spreadsheetId に顧客Spreadsheet IDを設定してください。');
  }

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const definitions = getCustomerSheetDefinitions_();
  const created = [];
  const existing = [];

  Object.keys(definitions).forEach(function(sheetName) {
    const headers = definitions[sheetName];
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      created.push(sheetName);
      return;
    }

    if (sheetName === 'Inquiries') {
      sheet = ensureInquirySummaryDetailSchema_(spreadsheet);
    }
    validateCustomerSheetHeaders_(sheet, headers);
    existing.push(sheetName);
  });

  ensureCustomerInitialSettings_(spreadsheet);

  return {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    createdSheets: created,
    existingSheets: existing,
    nextSteps: [
      'Settingsで問い合わせ受付アドレス、対象外ドメイン、INTERNAL_MAIL_DOMAINS等を設定する',
      '必要な顧客・担当者・社内メンバーを登録する',
      'MAIL_IMPORT_ENABLEDをTRUEにする',
      'installInquiryMailImportTrigger()を1回実行する',
      'Webアプリとしてデプロイする'
    ]
  };
}

function getCustomerSheetDefinitions_() {
  return {
    Users: ['user_id', 'user_name', 'email', 'role', 'active', 'member_id', 'updated_at'],
    Members: ['member_id', 'member_name', 'email', 'active', 'display_order', 'updated_at'],
    Settings: ['setting_key', 'setting_value', 'description', 'updated_at'],
    Customers: ['customer_id', 'customer_name', 'domain', 'status', 'note', 'updated_at'],
    CustomerContacts: ['contact_id', 'customer_id', 'contact_name', 'email', 'phone', 'active', 'updated_at'],
    Inquiries: [
      'inquiry_id', 'customer_id', 'contact_id', 'gmail_thread_id', 'subject',
      'status', 'priority', 'assigned_member_id', 'category', 'summary',
      'next_action', 'due_date', 'customer_match_status', 'received_at',
      'last_message_at', 'updated_at', 'detail'
    ],
    InquiryMessages: [
      'message_id', 'inquiry_id', 'gmail_message_id', 'gmail_thread_id', 'direction',
      'from_email', 'to_email', 'subject', 'body', 'sent_at', 'imported_at'
    ],
    InquiryCategories: ['category_id', 'category_name', 'active', 'display_order', 'updated_at']
  };
}

function validateCustomerSheetHeaders_(sheet, requiredHeaders) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const missing = requiredHeaders.filter(function(header) {
    return current.indexOf(header) < 0;
  });
  if (missing.length) {
    throw new Error('シート ' + sheet.getName() + ' に必要な列がありません: ' + missing.join(', '));
  }
}

function ensureCustomerInitialSettings_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName('Settings');
  const rows = readSheetObjects_(sheet);
  const existingKeys = {};
  rows.forEach(function(row) {
    const key = String(row.setting_key || '').trim();
    if (key) existingKeys[key] = true;
  });

  const defaults = [
    ['INQUIRY_GROUP_ADDRESS', '', '問い合わせ受付アドレス。複数ある場合はカンマ、改行、セミコロン区切り。'],
    ['MAIL_SEARCH_QUERY', 'to:{GROUP_ADDRESS} newer_than:30d', 'Gmail検索条件。複数受付時はto:{GROUP_ADDRESS}を各受付アドレスへのOR条件へ展開します。'],
    ['MAIL_IMPORT_MAX_THREADS', '50', '1回の取込処理で検索する最大スレッド数。'],
    ['MAIL_IMPORT_ENABLED', 'FALSE', 'TRUEの場合のみメール自動取込を実行します。'],
    ['INTERNAL_MAIL_DOMAINS', '', '自社送信と判定するメールドメイン。複数ある場合はカンマ、改行、セミコロン区切り。'],
    ['INQUIRY_EXCLUDED_DOMAINS', '', '問い合わせ一覧・ダッシュボードの対象外にする送信元ドメイン。複数指定可。'],
    ['GEMINI_AI_ENABLED', 'FALSE', '顧客環境ではAPIキー設定完了までFALSEを推奨します。'],
    ['GEMINI_MAX_INPUT_CHARS', '30000', 'AI要約へ渡す最大入力文字数。']
  ];

  defaults.forEach(function(item) {
    if (!existingKeys[item[0]]) {
      sheet.appendRow([item[0], item[1], item[2], new Date()]);
    }
  });
}


// --- bundled from DashboardApi.gs ---
function getDashboardData() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const allInquiries = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet));
  const inquiries = filterInquiryRowsByExcludedDomains_(spreadsheet, allInquiries);
  const customers = readSheetObjects_(requireSheet_(spreadsheet, 'Customers'));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, 'CustomerContacts'));
  const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
  const categories = readSheetObjects_(ensureInquiryCategorySheet_(spreadsheet));
  const settings = readSheetObjects_(requireSheet_(spreadsheet, 'Settings'));

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
  const activeStatuses = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER'];
  const openInquiries = inquiries.filter(function(row) {
    return activeStatuses.indexOf(String(row.status || 'NEW')) >= 0;
  });
  const overdue = openInquiries.filter(function(row) {
    const dueDate = formatDashboardDate_(row.due_date);
    return dueDate && dueDate < today;
  }).length;
  const unmatched = inquiries.filter(function(row) {
    const status = String(row.customer_match_status || '');
    return status === 'UNMATCHED' || status === 'AMBIGUOUS';
  }).length;

  const customerMap = {};
  customers.forEach(function(row) {
    customerMap[String(row.customer_id || '')] = String(row.customer_name || '');
  });
  const memberMap = {};
  members.forEach(function(row) {
    memberMap[String(row.member_id || '')] = String(row.member_name || '');
  });

  const recent = inquiries
    .map(function(row) {
      return {
        id: String(row.inquiry_id || ''),
        summary: String(row.summary || row.subject || ''),
        subject: String(row.subject || '(件名なし)'),
        customerName: customerMap[String(row.customer_id || '')] || '未特定',
        assignedMemberName: memberMap[String(row.assigned_member_id || '')] || '未担当',
        status: String(row.status || 'NEW'),
        priority: String(row.priority || 'MEDIUM'),
        lastMessageAt: formatDateForClient_(row.last_message_at || row.received_at, "yyyy-MM-dd'T'HH:mm:ss"),
        dueDate: formatDashboardDate_(row.due_date)
      };
    })
    .sort(function(a, b) {
      return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
    })
    .slice(0, 6);

  const settingMap = {};
  settings.forEach(function(row) {
    settingMap[String(row.setting_key || '')] = String(row.setting_value == null ? '' : row.setting_value);
  });

  return {
    summary: {
      total: inquiries.length,
      open: openInquiries.length,
      newCount: inquiries.filter(function(row) { return String(row.status || '') === 'NEW'; }).length,
      inProgress: inquiries.filter(function(row) { return String(row.status || '') === 'IN_PROGRESS'; }).length,
      waitingCustomer: inquiries.filter(function(row) { return String(row.status || '') === 'WAITING_CUSTOMER'; }).length,
      unmatched: unmatched,
      overdue: overdue
    },
    masters: {
      customers: customers.filter(function(row) { return String(row.status || 'ACTIVE') !== 'INACTIVE'; }).length,
      contacts: contacts.filter(function(row) { return !isFalse_(row.active); }).length,
      members: members.filter(function(row) { return !isFalse_(row.active); }).length,
      categories: categories.filter(function(row) { return String(row.category_id || '') && String(row.category_name || '') && !isFalse_(row.active); }).length
    },
    mailImportEnabled: String(settingMap.MAIL_IMPORT_ENABLED || '').toUpperCase() === 'TRUE',
    recent: recent,
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss")
  };
}

function formatDashboardDate_(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

// --- bundled from GeminiService.gs ---
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


// --- bundled from InquiryAiApi.gs ---
/** 問い合わせメール履歴からAI詳細候補を生成する。保存はしない。 */
function generateInquirySummary(inquiryId) {
  const id = String(inquiryId || '').trim();
  if (!id) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  ensureInquirySummaryDetailSchema_(spreadsheet);
  const settings = readAiSettings_(spreadsheet);
  if (!settings.enabled) throw new Error('AI要約機能は無効です。');

  const inquiry = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries)).find(function(row) {
    return String(row.inquiry_id || '') === id;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const messages = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages))
    .filter(function(row) { return String(row.inquiry_id || '') === id; })
    .sort(function(a, b) { return toAiTime_(a.sent_at) - toAiTime_(b.sent_at); });
  if (!messages.length) throw new Error('要約対象のメール履歴がありません。');

  const history = buildAiHistory_(messages, settings.maxInputChars);
  const prompt = [
    'あなたは業務問い合わせを整理するアシスタントです。',
    '以下のメール履歴を、担当者が短時間で状況把握できる日本語の詳細情報にしてください。',
    '要件:',
    '- 3〜6行程度で簡潔にまとめる',
    '- 問い合わせの主旨と顧客が求めていることを優先する',
    '- 期限・希望日・重要条件があれば含める',
    '- メールにない内容を推測しない',
    '- 挨拶、署名、定型文は原則省略する',
    '- そのまま詳細欄へ貼れる文章だけを返す',
    '',
    '問い合わせ概要: ' + String(inquiry.summary || inquiry.subject || ''),
    'メール件名: ' + String(inquiry.subject || ''),
    '',
    'メール履歴:',
    history
  ].join('\n');

  const generated = generateGeminiTextWithMeta_(prompt, settings.model, settings.fallbackModel);
  return {
    // 既存クライアント互換のためsummaryキーで返すが、画面上は「詳細」へ設定する。
    summary: generated.text,
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
    model: generated.model,
    fallbackUsed: generated.fallbackUsed
  };
}

function readAiSettings_(spreadsheet) {
  const values = {};
  readSheetObjects_(requireSheet_(spreadsheet, 'Settings')).forEach(function(row) {
    const key = String(row.setting_key || '').trim();
    if (key) values[key] = String(row.setting_value == null ? '' : row.setting_value).trim();
  });
  const n = Number(values.GEMINI_MAX_INPUT_CHARS || '30000');
  return {
    enabled: Object.prototype.hasOwnProperty.call(values, 'GEMINI_AI_ENABLED')
      ? String(values.GEMINI_AI_ENABLED).toUpperCase() === 'TRUE'
      : true,
    model: values.GEMINI_MODEL || 'gemini-3.8-flash',
    fallbackModel: values.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite',
    maxInputChars: Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 30000
  };
}

function buildAiHistory_(messages, maxChars) {
  const blocks = messages.map(function(row) {
    return [
      '方向: ' + String(row.direction || 'INBOUND'),
      '日時: ' + formatDateForClient_(row.sent_at, 'yyyy-MM-dd HH:mm:ss'),
      '送信元: ' + String(row.from_email || ''),
      '件名: ' + String(row.subject || ''),
      '本文:',
      cleanAiMailBody_(row.body)
    ].join('\n');
  });
  const selected = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (selected.length && total + block.length + 8 > maxChars) break;
    if (!selected.length && block.length > maxChars) {
      selected.unshift(block.slice(block.length - maxChars));
      break;
    }
    selected.unshift(block);
    total += block.length + 8;
  }
  return selected.join('\n\n---\n\n');
}

function cleanAiMailBody_(value) {
  let text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const patterns = [/^On .+ wrote:$/m, /^-{2,}\s*Original Message\s*-{2,}$/mi, /^-{2,}\s*元のメッセージ\s*-{2,}$/m];
  let cutAt = text.length;
  patterns.forEach(function(pattern) {
    const match = pattern.exec(text);
    if (match && match.index > 0) cutAt = Math.min(cutAt, match.index);
  });
  return text.slice(0, cutAt).trim();
}

function toAiTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}


// --- bundled from InquiryAiReplyApi.gs ---
/**
 * 問い合わせの管理情報とメール履歴から、顧客へ送る返信文案を生成する。
 * 文案は画面へ返すだけで、自動保存・自動送信しない。
 */
function generateInquiryReplyCandidate(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  ensureInquirySummaryDetailSchema_(spreadsheet);
  const settings = readAiSettings_(spreadsheet);
  if (!settings.enabled) throw new Error('AI機能は無効です。');

  const inquiry = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries)).find(function(row) {
    return String(row.inquiry_id || '') === inquiryId;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const messages = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages))
    .filter(function(row) { return String(row.inquiry_id || '') === inquiryId; })
    .sort(function(a, b) { return toAiTime_(a.sent_at) - toAiTime_(b.sent_at); });
  if (!messages.length) throw new Error('返信案を作成するメール履歴がありません。');

  // 旧UIとの互換性上、input.summaryには現在の「詳細」入力値が渡る場合がある。
  const detail = String(input.detail || input.summary || inquiry.detail || '');
  const management = [
    '顧客: ' + String(input.customerName || ''),
    '顧客担当者: ' + String(input.contactName || ''),
    '状態: ' + String(input.status || inquiry.status || ''),
    '優先度: ' + String(input.priority || inquiry.priority || ''),
    '自社担当: ' + String(input.assigneeName || ''),
    '分類: ' + String(input.category || inquiry.category || ''),
    '対応期限: ' + String(input.dueDate || inquiry.due_date || ''),
    '概要: ' + String(inquiry.summary || inquiry.subject || ''),
    '詳細: ' + detail,
    '次回対応: ' + String(input.nextAction || inquiry.next_action || '')
  ].join('\n');

  const history = buildAiHistory_(messages, settings.maxInputChars);
  const prompt = [
    'あなたは業務問い合わせへの返信文案を作るアシスタントです。',
    '以下の管理情報とメール履歴を踏まえ、担当者がそのまま確認・修正して送れる日本語の返信本文案を作成してください。',
    '要件:',
    '- 最新の顧客側メールへの返信として自然な内容にする',
    '- 管理情報の「概要」「詳細」「次回対応」「対応期限」を特に参考にする',
    '- 内部管理用の状態名、優先度、分類、自社担当などを顧客向け本文へ不用意に書かない',
    '- メールや管理情報にない事実を推測しない',
    '- 判断できない事項は断定せず、必要なら確認する表現にする',
    '- 丁寧で簡潔な業務メールにする',
    '- 件名、コードブロック、解説は付けず、返信本文だけを返す',
    '',
    'メール件名: ' + String(inquiry.subject || ''),
    '',
    '管理情報:',
    management,
    '',
    'メール履歴:',
    history
  ].join('\n');

  const generated = generateGeminiTextWithMeta_(prompt, settings.model, settings.fallbackModel);
  return {
    reply: generated.text,
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
    model: generated.model,
    fallbackUsed: generated.fallbackUsed
  };
}


// --- bundled from InquiryApi.gs ---
const INQUIRY_STATUS_VALUES = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
const INQUIRY_PRIORITY_VALUES = ['HIGH', 'MEDIUM', 'LOW'];

/**
 * 問い合わせ管理画面の初期表示データを返す。
 * メール本文は初期表示では取得せず、getInquiryMessages() で選択時に取得する。
 */
function getInquiryScreenData() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts));
  const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
  const categories = readSheetObjects_(ensureInquiryCategorySheet_(spreadsheet));
  const allInquiries = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet));
  const inquiries = filterInquiryRowsByExcludedDomains_(spreadsheet, allInquiries);

  const customerById = indexBy_(customers, 'customer_id');
  const contactById = indexBy_(contacts, 'contact_id');
  const memberById = indexBy_(members, 'member_id');

  return {
    inquiries: inquiries.map(function(row) {
      const customer = customerById[String(row.customer_id || '')] || {};
      const contact = contactById[String(row.contact_id || '')] || {};
      const member = memberById[String(row.assigned_member_id || '')] || {};
      return serializeInquiry_(row, customer, contact, member);
    }).sort(function(a, b) {
      return String(b.lastMessageAt || b.receivedAt).localeCompare(String(a.lastMessageAt || a.receivedAt));
    }),
    customers: customers.map(function(row) {
      return {
        id: String(row.customer_id || ''),
        name: String(row.customer_name || ''),
        domain: String(row.domain || ''),
        status: String(row.status || 'ACTIVE')
      };
    }),
    contacts: contacts.map(function(row) {
      return {
        id: String(row.contact_id || ''),
        customerId: String(row.customer_id || ''),
        name: String(row.contact_name || ''),
        email: String(row.email || ''),
        active: !isFalse_(row.active)
      };
    }),
    members: members.map(function(row) {
      return {
        id: String(row.member_id || ''),
        name: String(row.member_name || ''),
        active: !isFalse_(row.active)
      };
    }),
    categories: categories.map(function(row) {
      return {
        id: String(row.category_id || ''),
        name: String(row.category_name || ''),
        active: !isFalse_(row.active),
        displayOrder: row.display_order === '' ? '' : Number(row.display_order)
      };
    }).sort(sortByDisplayOrder_),
    statusValues: INQUIRY_STATUS_VALUES,
    priorityValues: INQUIRY_PRIORITY_VALUES
  };
}

/**
 * 選択された問い合わせのメール履歴だけを取得する。
 * InquiryMessages 全件の本文を読み込まないよう、最初に inquiry_id 列だけを走査し、
 * 該当行のみ本文を含む行データを読む。
 */
function getInquiryMessages(inquiryId) {
  const id = String(inquiryId || '').trim();
  if (!id) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const inquiryIdIndex = headers.indexOf('inquiry_id');
  if (inquiryIdIndex < 0) throw new Error('Missing header: inquiry_id in ' + sheet.getName());

  const ids = sheet.getRange(2, inquiryIdIndex + 1, lastRow - 1, 1).getValues();
  const rowNumbers = [];
  ids.forEach(function(row, index) {
    if (String(row[0] || '') === id) rowNumbers.push(index + 2);
  });
  if (!rowNumbers.length) return [];

  const messages = rowNumbers.map(function(rowNumber) {
    const values = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
    const row = {};
    headers.forEach(function(header, index) {
      if (header) row[header] = values[index];
    });
    return serializeInquiryMessage_(row);
  });

  // UIでは最新のやり取りを最初に確認できるよう新しい順で返す。
  messages.sort(function(a, b) {
    return String(b.sentAt).localeCompare(String(a.sentAt));
  });
  return messages;
}

/**
 * 顧客未特定（UNMATCHED / AMBIGUOUS）の問い合わせだけを、現在の顧客・担当者マスタで再判定する。
 * 手動設定済みや既に自動確定済みの問い合わせは上書きしない。
 */
function reassessUnmatchedInquiries() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = ensureInquirySummaryDetailSchema_(spreadsheet);
  const inquiries = readSheetObjects_(inquirySheet);
  const targets = inquiries.filter(function(row) {
    const status = String(row.customer_match_status || 'UNMATCHED');
    return status === 'UNMATCHED' || status === 'AMBIGUOUS';
  });

  if (!targets.length) {
    return { checked: 0, matched: 0, remaining: 0, data: getInquiryScreenData() };
  }

  const targetIds = new Set(targets.map(function(row) { return String(row.inquiry_id || ''); }));
  const senderByInquiry = loadLatestInboundSenderByInquiry_(spreadsheet, targetIds);
  const customerData = loadCustomerMatchData_(spreadsheet);
  let matched = 0;
  let remaining = 0;

  targets.forEach(function(inquiry) {
    const inquiryId = String(inquiry.inquiry_id || '');
    const fromEmail = senderByInquiry[inquiryId] || '';
    if (!fromEmail) {
      remaining += 1;
      return;
    }

    const result = matchCustomer_(fromEmail, customerData);
    const isMatched = result.status === 'EXACT_CONTACT' || result.status === 'DOMAIN_MATCH';
    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      customer_id: isMatched ? result.customerId : '',
      contact_id: isMatched ? result.contactId : '',
      customer_match_status: result.status,
      updated_at: new Date()
    });

    if (isMatched) matched += 1;
    else remaining += 1;
  });

  return {
    checked: targets.length,
    matched: matched,
    remaining: remaining,
    data: getInquiryScreenData()
  };
}

/**
 * 再判定ではメール本文を読まず、必要な4列だけを走査する。
 * 同一問い合わせに複数の受信メールがある場合は最新の送信元を判定に使う。
 */
function loadLatestInboundSenderByInquiry_(spreadsheet, targetIds) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return {};

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const inquiryIndex = headers.indexOf('inquiry_id');
  const directionIndex = headers.indexOf('direction');
  const fromIndex = headers.indexOf('from_email');
  const sentAtIndex = headers.indexOf('sent_at');
  if ([inquiryIndex, directionIndex, fromIndex, sentAtIndex].some(function(index) { return index < 0; })) {
    throw new Error('InquiryMessages に再判定に必要な列がありません。');
  }

  const rowCount = lastRow - 1;
  const inquiryIds = sheet.getRange(2, inquiryIndex + 1, rowCount, 1).getValues();
  const directions = sheet.getRange(2, directionIndex + 1, rowCount, 1).getValues();
  const fromEmails = sheet.getRange(2, fromIndex + 1, rowCount, 1).getValues();
  const sentAts = sheet.getRange(2, sentAtIndex + 1, rowCount, 1).getValues();
  const result = {};

  for (let i = 0; i < rowCount; i += 1) {
    const inquiryId = String(inquiryIds[i][0] || '');
    if (!targetIds.has(inquiryId)) continue;
    if (String(directions[i][0] || 'INBOUND').toUpperCase() !== 'INBOUND') continue;
    const fromEmail = normalizeEmail_(fromEmails[i][0]);
    if (!fromEmail) continue;
    const time = toInquiryTime_(sentAts[i][0]);
    if (!result[inquiryId] || time >= result[inquiryId].time) {
      result[inquiryId] = { email: fromEmail, time: time };
    }
  }

  const senderByInquiry = {};
  Object.keys(result).forEach(function(inquiryId) {
    senderByInquiry[inquiryId] = result[inquiryId].email;
  });
  return senderByInquiry;
}

function toInquiryTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * 問い合わせの管理項目を更新する。
 * メール本文・Gmail IDなどの受信情報はこのAPIでは変更しない。
 */
function updateInquiry(input) {
  if (!input || !input.inquiryId) throw new Error('inquiryId is required.');
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = ensureInquirySummaryDetailSchema_(spreadsheet);
  const rows = readSheetObjects_(inquirySheet);
  const row = rows.find(function(item) { return String(item.inquiry_id || '') === String(input.inquiryId || ''); });
  if (!row) throw new Error('問い合わせが見つかりません。');

  const customerId = String(input.customerId || '').trim();
  const contactId = String(input.contactId || '').trim();
  const assignedMemberId = String(input.assignedMemberId || '').trim();
  const status = String(input.status || '').trim();
  const priority = String(input.priority || '').trim();

  if (status && INQUIRY_STATUS_VALUES.indexOf(status) < 0) throw new Error('問い合わせ状態が不正です。');
  if (priority && INQUIRY_PRIORITY_VALUES.indexOf(priority) < 0) throw new Error('優先度が不正です。');

  const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts));
  const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
  if (customerId && !customers.some(function(item) { return String(item.customer_id || '') === customerId; })) throw new Error('顧客が見つかりません。');
  const contact = contactId ? contacts.find(function(item) { return String(item.contact_id || '') === contactId; }) : null;
  if (contactId && !contact) throw new Error('顧客担当者が見つかりません。');
  if (contact && customerId && String(contact.customer_id || '') !== customerId) throw new Error('顧客担当者が選択した顧客に属していません。');
  if (assignedMemberId && !members.some(function(item) { return String(item.member_id || '') === assignedMemberId; })) throw new Error('社内担当者が見つかりません。');

  const customerChanged = String(row.customer_id || '') !== customerId || String(row.contact_id || '') !== contactId;
  const summary = String(input.summary || '').trim() || String(row.subject || '').trim();
  writeRowUpdates_(inquirySheet, row._rowIndex, {
    customer_id: customerId,
    contact_id: contactId,
    status: status || 'NEW',
    priority: priority || 'MEDIUM',
    assigned_member_id: assignedMemberId,
    category: String(input.category || '').trim(),
    summary: summary,
    detail: String(input.detail || '').trim(),
    next_action: String(input.nextAction || '').trim(),
    due_date: String(input.dueDate || '').trim(),
    customer_match_status: customerChanged ? 'MANUAL' : String(row.customer_match_status || 'UNMATCHED'),
    updated_at: new Date()
  });

  return getInquiryScreenData();
}

function indexBy_(rows, key) {
  const result = {};
  rows.forEach(function(row) {
    const value = String(row[key] || '');
    if (value) result[value] = row;
  });
  return result;
}

function serializeInquiry_(row, customer, contact, member) {
  return {
    id: String(row.inquiry_id || ''),
    customerId: String(row.customer_id || ''),
    customerName: String(customer.customer_name || ''),
    contactId: String(row.contact_id || ''),
    contactName: String(contact.contact_name || ''),
    contactEmail: String(contact.email || ''),
    subject: String(row.subject || ''),
    status: String(row.status || 'NEW'),
    priority: String(row.priority || 'MEDIUM'),
    assignedMemberId: String(row.assigned_member_id || ''),
    assignedMemberName: String(member.member_name || ''),
    category: String(row.category || ''),
    summary: String(row.summary || row.subject || ''),
    detail: String(row.detail || ''),
    nextAction: String(row.next_action || ''),
    dueDate: formatDateForClient_(row.due_date, 'yyyy-MM-dd'),
    customerMatchStatus: String(row.customer_match_status || 'UNMATCHED'),
    receivedAt: formatDateForClient_(row.received_at, "yyyy-MM-dd'T'HH:mm:ss"),
    lastMessageAt: formatDateForClient_(row.last_message_at, "yyyy-MM-dd'T'HH:mm:ss"),
    updatedAt: formatDateForClient_(row.updated_at, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

function serializeInquiryMessage_(row) {
  return {
    id: String(row.message_id || ''),
    direction: String(row.direction || 'INBOUND'),
    fromEmail: String(row.from_email || ''),
    toEmail: String(row.to_email || ''),
    subject: String(row.subject || ''),
    body: String(row.body || ''),
    sentAt: formatDateForClient_(row.sent_at, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

function formatDateForClient_(value, pattern) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), pattern);
  return String(value);
}


// --- bundled from InquiryBulkExclusionApi.gs ---
/**
 * 問い合わせ一覧で選択した未特定問い合わせの送信元ドメインを、まとめて対象外登録する。
 * 対象外はドメイン単位で適用し、同じドメインから開始した問い合わせは既存分も含めて非表示にする。
 * 登録したドメインとの完全一致だけを対象とし、未登録の別ドメインやサブドメインへは広げない。
 */
function excludeInquiryDomainsBulk(input) {
  input = input || {};
  const inquiryIds = Array.isArray(input.inquiryIds) ? input.inquiryIds.map(function(value) {
    return String(value || '').trim();
  }).filter(Boolean) : [];

  const uniqueIds = inquiryIds.filter(function(id, index, values) {
    return values.indexOf(id) === index;
  });
  if (!uniqueIds.length) throw new Error('対象の問い合わせを選択してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquiryRows = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet));
    const inquiryById = {};
    inquiryRows.forEach(function(row) {
      inquiryById[String(row.inquiry_id || '')] = row;
    });

    const firstSenderByInquiry = loadFirstInboundSenderByInquiry_(spreadsheet, new Set(uniqueIds));
    const domains = [];
    const excludedInquiryIds = [];
    const skipped = [];

    uniqueIds.forEach(function(inquiryId) {
      const inquiry = inquiryById[inquiryId];
      if (!inquiry) {
        skipped.push({ inquiryId: inquiryId, reason: '問い合わせが見つかりません。' });
        return;
      }
      if (String(inquiry.customer_id || '').trim()) {
        skipped.push({ inquiryId: inquiryId, reason: '顧客特定済みのため対象外登録しませんでした。' });
        return;
      }

      const sender = firstSenderByInquiry[inquiryId] || '';
      const at = String(sender).lastIndexOf('@');
      const domain = at > 0 && at < String(sender).length - 1
        ? normalizeDomain_(String(sender).slice(at + 1))
        : '';
      if (!domain) {
        skipped.push({ inquiryId: inquiryId, reason: '送信元ドメインを取得できませんでした。' });
        return;
      }

      if (domains.indexOf(domain) < 0) domains.push(domain);
      excludedInquiryIds.push(inquiryId);
    });

    if (!domains.length) throw new Error('対象外登録できる送信元ドメインがありません。');

    const settingsSheet = requireSheet_(spreadsheet, 'Settings');
    const settingsRows = readSheetObjects_(settingsSheet);
    let settingRow = settingsRows.find(function(row) {
      return String(row.setting_key || '') === 'INQUIRY_EXCLUDED_DOMAINS';
    });
    const current = settingRow ? String(settingRow.setting_value || '') : '';
    const mergedValue = normalizeDomainListSetting_([current].concat(domains).filter(Boolean).join(', '));

    if (settingRow) {
      writeRowUpdates_(settingsSheet, settingRow._rowIndex, {
        setting_value: mergedValue,
        updated_at: new Date()
      });
    } else {
      settingsSheet.appendRow([
        'INQUIRY_EXCLUDED_DOMAINS',
        mergedValue,
        '問い合わせ一覧・集計から除外する送信元ドメイン。登録ドメインとの完全一致で判定する。',
        new Date()
      ]);
    }

    return {
      domains: domains,
      excludedInquiryIds: excludedInquiryIds,
      skipped: skipped,
      inquiryData: getInquiryScreenData()
    };
  } finally {
    lock.releaseLock();
  }
}


// --- bundled from InquiryCustomerRegistrationApi.gs ---
/**
 * 問い合わせ管理画面から、未特定の送信元を顧客登録・対象外登録したり、
 * 顧客特定済みの問い合わせから顧客担当者を登録するためのAPI。
 */

/** 問い合わせ内の受信メールアドレスを、メール日時順に重複なく返す。 */
function loadInquiryInboundEmails_(spreadsheet, inquiryId) {
  const rows = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages))
    .filter(function(row) {
      return String(row.inquiry_id || '') === String(inquiryId || '') &&
        String(row.direction || 'INBOUND').toUpperCase() === 'INBOUND';
    })
    .sort(function(a, b) {
      return toInquiryTime_(a.sent_at) - toInquiryTime_(b.sent_at);
    });

  const seen = {};
  return rows.map(function(row) {
    return extractEmailAddress_(row.from_email) || normalizeEmail_(row.from_email);
  }).filter(function(email) {
    email = normalizeEmail_(email);
    if (!email || seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

function domainFromInquiryEmail_(email) {
  const normalized = normalizeEmail_(email);
  const at = normalized.lastIndexOf('@');
  return at > 0 && at < normalized.length - 1 ? normalizeDomain_(normalized.slice(at + 1)) : '';
}

function matchesCustomerDomain_(email, customerDomain) {
  const emailDomain = domainFromInquiryEmail_(email);
  const domain = normalizeDomain_(customerDomain);
  return !!emailDomain && !!domain && (emailDomain === domain || emailDomain.endsWith('.' + domain));
}

/** 未特定問い合わせの受信ドメインを新しい顧客として登録し、問い合わせへ設定する。 */
function registerCustomerFromInquiry(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const requestedDomain = normalizeDomain_(input.domain);
  const customerName = String(input.customerName || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!customerName) throw new Error('顧客名を入力してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquirySheet = ensureInquirySummaryDetailSchema_(spreadsheet);
    const customerSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.customers);
    const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('問い合わせが見つかりません。');
    if (String(inquiry.customer_id || '').trim()) throw new Error('この問い合わせには既に顧客が設定されています。');

    const inboundEmails = loadInquiryInboundEmails_(spreadsheet, inquiryId);
    const domains = inboundEmails.map(domainFromInquiryEmail_).filter(Boolean);
    const domain = requestedDomain || domains[0] || '';
    if (!domain || domains.indexOf(domain) < 0) throw new Error('問い合わせ履歴に存在する送信元ドメインを指定してください。');

    const existing = readSheetObjects_(customerSheet).find(function(row) {
      return normalizeDomain_(row.domain) === domain;
    });
    if (existing) throw new Error('このドメインは既に顧客「' + String(existing.customer_name || existing.customer_id || '') + '」へ登録されています。');

    const customerId = saveMasterRow_(customerSheet, 'customer_id', '', 'CUS', {
      customer_name: customerName,
      domain: domain,
      status: 'ACTIVE',
      note: '問い合わせ管理画面から登録',
      updated_at: new Date()
    });

    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      customer_id: customerId,
      contact_id: '',
      customer_match_status: 'MANUAL',
      updated_at: new Date()
    });

    return { customerId: customerId, customerName: customerName, domain: domain, inquiryData: getInquiryScreenData() };
  } finally {
    lock.releaseLock();
  }
}

/** 未特定問い合わせの受信ドメインを問い合わせ対象外へ追加する。データ自体は削除しない。 */
function excludeDomainFromInquiry(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const requestedDomain = normalizeDomain_(input.domain);
  if (!inquiryId) throw new Error('inquiryId is required.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquiry = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet)).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('問い合わせが見つかりません。');
    if (String(inquiry.customer_id || '').trim()) throw new Error('顧客特定済みの問い合わせは対象外登録できません。');

    const domains = loadInquiryInboundEmails_(spreadsheet, inquiryId).map(domainFromInquiryEmail_).filter(Boolean);
    const domain = requestedDomain || domains[0] || '';
    if (!domain || domains.indexOf(domain) < 0) throw new Error('問い合わせ履歴に存在する送信元ドメインを指定してください。');

    const sheet = requireSheet_(spreadsheet, 'Settings');
    const rows = readSheetObjects_(sheet);
    let row = rows.find(function(item) { return String(item.setting_key || '') === 'INQUIRY_EXCLUDED_DOMAINS'; });
    const current = row ? String(row.setting_value || '') : '';
    const domainsValue = normalizeDomainListSetting_([current, domain].filter(Boolean).join(', '));

    if (row) {
      writeRowUpdates_(sheet, row._rowIndex, { setting_value: domainsValue, updated_at: new Date() });
    } else {
      sheet.appendRow(['INQUIRY_EXCLUDED_DOMAINS', domainsValue, '問い合わせ一覧・集計から除外する送信元ドメイン。', new Date()]);
    }

    return { domain: domain, inquiryData: getInquiryScreenData() };
  } finally {
    lock.releaseLock();
  }
}

/** 顧客特定済み・担当者未設定の問い合わせから、その顧客ドメインのメールアドレスを担当者登録する。 */
function registerContactFromInquiry(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const email = normalizeEmail_(input.email);
  const contactName = String(input.contactName || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!email) throw new Error('メールアドレスを選択してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquirySheet = ensureInquirySummaryDetailSchema_(spreadsheet);
    const contactSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts);
    const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
    const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('問い合わせが見つかりません。');
    const customerId = String(inquiry.customer_id || '').trim();
    if (!customerId) throw new Error('先に顧客を特定してください。');
    if (String(inquiry.contact_id || '').trim()) throw new Error('この問い合わせには既に顧客担当者が設定されています。');

    const customer = customers.find(function(row) { return String(row.customer_id || '') === customerId; });
    if (!customer) throw new Error('設定されている顧客が見つかりません。');
    const customerDomain = normalizeDomain_(customer.domain);
    if (!customerDomain) throw new Error('顧客マスタにメールドメインが設定されていません。');

    const candidates = loadInquiryInboundEmails_(spreadsheet, inquiryId).filter(function(candidate) {
      return matchesCustomerDomain_(candidate, customerDomain);
    });
    if (candidates.indexOf(email) < 0) throw new Error('このメールアドレスは問い合わせ履歴の顧客ドメインに含まれていません。');

    const existing = readSheetObjects_(contactSheet).find(function(row) {
      return normalizeEmail_(row.email) === email;
    });
    if (existing) throw new Error('このメールアドレスは既に顧客担当者として登録されています。');

    const contactId = saveMasterRow_(contactSheet, 'contact_id', '', 'CON', {
      customer_id: customerId,
      contact_name: contactName,
      email: email,
      phone: '',
      active: true,
      updated_at: new Date()
    });

    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      contact_id: contactId,
      customer_match_status: 'MANUAL',
      updated_at: new Date()
    });

    return { contactId: contactId, email: email, contactName: contactName, inquiryData: getInquiryScreenData() };
  } finally {
    lock.releaseLock();
  }
}

/** 旧メール履歴UIとの互換用。管理情報UIへ移行後も一時的に呼び出し可能にする。 */
function registerCustomerFromInquiryMessage(input) {
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const message = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages)).find(function(row) {
    return String(row.message_id || '') === String(input.messageId || '') && String(row.inquiry_id || '') === String(input.inquiryId || '');
  });
  if (!message) throw new Error('対象メールが見つかりません。');
  return registerCustomerFromInquiry({
    inquiryId: input.inquiryId,
    customerName: input.customerName,
    domain: domainFromInquiryEmail_(message.from_email)
  });
}


// --- bundled from InquiryExclusion.gs ---
/**
 * 問い合わせ一覧の対象外ドメイン設定を読み込む。
 * 登録したドメインと完全一致する送信元だけを対象外とする。
 */
function loadInquiryExcludedDomains_(spreadsheet) {
  const settings = loadSettings_(spreadsheet);
  return parseSettingList_(settings.INQUIRY_EXCLUDED_DOMAINS).map(function(value) {
    return normalizeMatchDomain_(value);
  }).filter(function(domain, index, values) {
    return !!domain && values.indexOf(domain) === index;
  });
}

function isInquiryExcludedDomain_(emailOrDomain, excludedDomains) {
  const text = String(emailOrDomain || '').trim().toLowerCase();
  const domain = normalizeMatchDomain_(text.indexOf('@') >= 0 ? text.split('@').slice(-1)[0] : text);
  if (!domain) return false;
  return (excludedDomains || []).some(function(excluded) {
    return domain === normalizeMatchDomain_(excluded);
  });
}

/**
 * 問い合わせの開始元となった最初の受信メール送信元を取得する。
 * 一覧対象外判定は、後続メールで表示可否が揺れないよう開始元で固定する。
 */
function loadFirstInboundSenderByInquiry_(spreadsheet, inquiryIds) {
  const targetIds = inquiryIds instanceof Set ? inquiryIds : new Set((inquiryIds || []).map(String));
  if (!targetIds.size) return {};

  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const rows = readSheetObjects_(sheet);
  const result = {};

  rows.forEach(function(row) {
    const inquiryId = String(row.inquiry_id || '');
    if (!targetIds.has(inquiryId)) return;
    if (String(row.direction || 'INBOUND').toUpperCase() !== 'INBOUND') return;
    const fromEmail = extractEmailAddress_(row.from_email) || normalizeEmail_(row.from_email);
    if (!fromEmail) return;
    const time = toInquiryTime_(row.sent_at);
    if (!result[inquiryId] || time < result[inquiryId].time) {
      result[inquiryId] = { email: fromEmail, time: time };
    }
  });

  const senderByInquiry = {};
  Object.keys(result).forEach(function(inquiryId) {
    senderByInquiry[inquiryId] = result[inquiryId].email;
  });
  return senderByInquiry;
}

/**
 * Settings の対象外ドメインに完全一致する問い合わせを一覧・集計から除外する。
 * データ自体は削除しないため、設定から外せば再表示できる。
 */
function filterInquiryRowsByExcludedDomains_(spreadsheet, inquiries) {
  const rows = inquiries || [];
  const excludedDomains = loadInquiryExcludedDomains_(spreadsheet);
  if (!excludedDomains.length || !rows.length) return rows;

  const ids = new Set(rows.map(function(row) {
    return String(row.inquiry_id || '');
  }).filter(Boolean));
  const firstSenderByInquiry = loadFirstInboundSenderByInquiry_(spreadsheet, ids);

  return rows.filter(function(row) {
    const sender = firstSenderByInquiry[String(row.inquiry_id || '')] || '';
    return !sender || !isInquiryExcludedDomain_(sender, excludedDomains);
  });
}


// --- bundled from InquiryMailImport.gs ---
const INQUIRY_SHEETS = {
  settings: 'Settings',
  customers: 'Customers',
  contacts: 'CustomerContacts',
  inquiries: 'Inquiries',
  messages: 'InquiryMessages'
};

const INQUIRY_SETTINGS = {
  enabled: 'MAIL_IMPORT_ENABLED',
  groupAddress: 'INQUIRY_GROUP_ADDRESS',
  searchQuery: 'MAIL_SEARCH_QUERY',
  maxThreads: 'MAIL_IMPORT_MAX_THREADS',
  internalDomains: 'INTERNAL_MAIL_DOMAINS'
};

/**
 * Googleグループ等の問い合わせ受付アドレス宛にGmailへ配信されたメールを問い合わせとして取り込む。
 * 通常の時間主導トリガーでは MAIL_IMPORT_ENABLED が TRUE の場合のみ実行する。
 * 画面からの手動実行時は { force: true } を渡し、自動取込設定にかかわらず1回だけ実行できる。
 */
function importInquiryEmails(options) {
  options = options || {};
  const force = options.force === true;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Inquiry mail import is already running.');
    return { imported: 0, skipped: 0, errors: 0, reason: 'LOCKED' };
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const settings = loadSettings_(spreadsheet);

    if (!force && !isTrue_(settings[INQUIRY_SETTINGS.enabled])) {
      return { imported: 0, skipped: 0, errors: 0, reason: 'DISABLED' };
    }

    const receptionAddresses = getInquiryReceptionAddresses_(settings);
    if (!receptionAddresses.length) {
      throw new Error('INQUIRY_GROUP_ADDRESS is not configured.');
    }

    const query = buildInquiryMailQuery_(settings, receptionAddresses);
    const maxThreads = Math.max(1, Number(settings[INQUIRY_SETTINGS.maxThreads]) || 50);
    const threads = GmailApp.search(query, 0, maxThreads).slice().reverse();

    const messageSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
    const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
    const importedMessageIds = loadColumnSet_(messageSheet, 'gmail_message_id');
    const inquiryByThreadId = loadRows_(inquirySheet, 'gmail_thread_id');
    const customerData = loadCustomerMatchData_(spreadsheet);
    const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    threads.forEach(function(thread) {
      const messages = thread.getMessages().slice().sort(function(a, b) {
        return a.getDate().getTime() - b.getDate().getTime();
      });

      messages.forEach(function(message) {
        try {
          const gmailMessageId = message.getId();
          if (importedMessageIds.has(gmailMessageId)) {
            skipped += 1;
            return;
          }

          const direction = classifyInquiryMessageDirection_(message, internalIdentity);
          if (!direction) {
            skipped += 1;
            return;
          }

          const gmailThreadId = thread.getId();
          const fromEmail = extractEmailAddress_(message.getFrom());
          let inquiry = inquiryByThreadId[gmailThreadId];

          if (!inquiry && direction !== 'INBOUND') {
            skipped += 1;
            return;
          }

          if (!inquiry) {
            const matchedCustomer = matchCustomer_(fromEmail, customerData);
            inquiry = createInquiry_(inquirySheet, {
              gmailThreadId: gmailThreadId,
              subject: message.getSubject(),
              matchedCustomer: matchedCustomer,
              receivedAt: message.getDate()
            });
            inquiryByThreadId[gmailThreadId] = inquiry;
          } else {
            updateInquiryLastMessageAt_(inquirySheet, inquiry, message.getDate());
          }

          appendInquiryMessage_(messageSheet, {
            inquiryId: inquiry.inquiry_id,
            gmailMessageId: gmailMessageId,
            gmailThreadId: gmailThreadId,
            direction: direction,
            fromEmail: fromEmail,
            toEmail: message.getTo(),
            subject: message.getSubject(),
            body: message.getPlainBody(),
            sentAt: message.getDate()
          });

          importedMessageIds.add(gmailMessageId);
          imported += 1;
        } catch (error) {
          errors += 1;
          console.error('Inquiry mail import failed for one message: ' + error.message);
        }
      });
    });

    return { imported: imported, skipped: skipped, errors: errors, query: query, manual: force };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 実アドレス設定後の確認用。スプレッドシートは更新せず、候補メールだけ返す。
 */
function previewInquiryMailCandidates() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const settings = loadSettings_(spreadsheet);
  const receptionAddresses = getInquiryReceptionAddresses_(settings);
  if (!receptionAddresses.length) {
    throw new Error('INQUIRY_GROUP_ADDRESS is not configured.');
  }

  const query = buildInquiryMailQuery_(settings, receptionAddresses);
  const threads = GmailApp.search(query, 0, 10);
  const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);
  const result = [];

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      const direction = classifyInquiryMessageDirection_(message, internalIdentity);
      if (direction) {
        result.push({
          gmailMessageId: message.getId(),
          gmailThreadId: thread.getId(),
          direction: direction,
          from: message.getFrom(),
          to: message.getTo(),
          cc: message.getCc(),
          subject: message.getSubject(),
          date: message.getDate()
        });
      }
    });
  });

  return result.slice(0, 20);
}

/**
 * 既存のInquiryMessages.directionを現在の自社メール設定で再判定する。
 * 自社メールアドレスは有効なMembers.emailと問い合わせ受付アドレスから組み立てる。
 */
function reclassifyInquiryMessageDirections() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const settings = loadSettings_(spreadsheet);
  const receptionAddresses = getInquiryReceptionAddresses_(settings);
  const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);
  if (!internalIdentity.domains.size && !internalIdentity.addresses.size) {
    throw new Error('INTERNAL_MAIL_DOMAINS、社内メンバーのメールアドレス、問い合わせ受付アドレスのいずれかを設定してください。');
  }

  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) {
    return { checked: 0, changed: 0, inbound: 0, outbound: 0 };
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const directionIndex = headers.indexOf('direction');
  const fromIndex = headers.indexOf('from_email');
  if (directionIndex < 0 || fromIndex < 0) {
    throw new Error('InquiryMessages に direction / from_email 列がありません。');
  }

  const rowCount = lastRow - 1;
  const directions = sheet.getRange(2, directionIndex + 1, rowCount, 1).getValues();
  const fromEmails = sheet.getRange(2, fromIndex + 1, rowCount, 1).getValues();
  let checked = 0;
  let changed = 0;
  let inbound = 0;
  let outbound = 0;

  for (let i = 0; i < rowCount; i += 1) {
    const fromEmail = extractEmailAddress_(fromEmails[i][0]) || normalizeEmail_(fromEmails[i][0]);
    if (!fromEmail || fromEmail.indexOf('@') < 0) continue;
    checked += 1;
    const direction = isInternalEmail_(fromEmail, internalIdentity) ? 'OUTBOUND' : 'INBOUND';
    if (direction === 'OUTBOUND') outbound += 1;
    else inbound += 1;
    if (String(directions[i][0] || '').toUpperCase() !== direction) {
      directions[i][0] = direction;
      changed += 1;
    }
  }

  if (changed > 0) {
    sheet.getRange(2, directionIndex + 1, rowCount, 1).setValues(directions);
  }
  return { checked: checked, changed: changed, inbound: inbound, outbound: outbound };
}

/**
 * 5分間隔の時間主導トリガーを作成する。設定確認後に一度だけ手動実行する。
 */
function installInquiryMailImportTrigger() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const settings = loadSettings_(spreadsheet);
  if (!isTrue_(settings[INQUIRY_SETTINGS.enabled])) {
    throw new Error('MAIL_IMPORT_ENABLED must be TRUE before installing the trigger.');
  }
  if (!getInquiryReceptionAddresses_(settings).length) {
    throw new Error('INQUIRY_GROUP_ADDRESS is not configured.');
  }

  ScriptApp.getProjectTriggers()
    .filter(function(trigger) { return trigger.getHandlerFunction() === 'importInquiryEmails'; })
    .forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });

  ScriptApp.newTrigger('importInquiryEmails')
    .timeBased()
    .everyMinutes(5)
    .create();
}

/**
 * 受付アドレス設定は既存keyを維持したまま複数値を許可する。
 */
function getInquiryReceptionAddresses_(settings) {
  const seen = {};
  return parseSettingList_(settings[INQUIRY_SETTINGS.groupAddress]).map(function(value) {
    return extractEmailAddress_(value) || normalizeEmail_(value);
  }).filter(function(email) {
    if (!email || email.indexOf('@') < 1 || seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

/**
 * 既存の to:{GROUP_ADDRESS} を維持しつつ、複数受付時はGmailのOR検索へ展開する。
 */
function buildInquiryMailQuery_(settings, receptionAddresses) {
  const template = String(settings[INQUIRY_SETTINGS.searchQuery] || 'to:{GROUP_ADDRESS} newer_than:30d').trim();
  const addresses = receptionAddresses || [];
  if (!addresses.length) return template;
  const recipientQuery = addresses.length === 1
    ? 'to:' + addresses[0]
    : '{' + addresses.map(function(address) { return 'to:' + address; }).join(' ') + '}';
  return template
    .replace(/to:\{GROUP_ADDRESS\}/g, recipientQuery)
    .replace(/\{GROUP_ADDRESS_QUERY\}/g, recipientQuery)
    .replace(/\{GROUP_ADDRESS\}/g, addresses[0]);
}

/**
 * 自社側メールの判定情報を作る。
 * 個別アドレスは手入力せず、問い合わせ受付アドレスと有効な社内メンバーのメールアドレスから生成する。
 * 自社ドメインはINTERNAL_MAIL_DOMAINSを利用する。
 */
function loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses) {
  const addresses = new Set();
  const domains = new Set();

  function addAddress(value) {
    const email = extractEmailAddress_(value) || normalizeEmail_(value);
    if (email && email.indexOf('@') >= 0) addresses.add(email);
  }
  function addDomain(value) {
    const domain = normalizeMatchDomain_(value);
    if (domain) domains.add(domain);
  }

  parseSettingList_(settings[INQUIRY_SETTINGS.internalDomains]).forEach(addDomain);
  (receptionAddresses || []).forEach(addAddress);

  readSheetObjects_(requireSheet_(spreadsheet, 'Members')).forEach(function(member) {
    if (!isFalse_(member.active)) addAddress(member.email);
  });

  return { addresses: addresses, domains: domains };
}

function parseSettingList_(value) {
  return String(value == null ? '' : value)
    .split(/[\n,;]+/)
    .map(function(item) { return String(item || '').trim(); })
    .filter(function(item) { return !!item; });
}

function isInternalEmail_(email, internalIdentity) {
  const normalized = extractEmailAddress_(email) || normalizeEmail_(email);
  if (!normalized || normalized.indexOf('@') < 0) return false;
  if (internalIdentity.addresses.has(normalized)) return true;
  const domain = normalizeMatchDomain_(normalized.split('@').slice(-1)[0]);
  return !!domain && internalIdentity.domains.has(domain);
}

/**
 * メール方向を判定する。
 * Fromが自社アドレス/自社ドメインならOUTBOUND、それ以外の送信元はINBOUNDとする。
 * Fromが取得できない場合だけTo/Ccを補助判定に使う。
 */
function classifyInquiryMessageDirection_(message, internalIdentity) {
  const fromEmail = extractEmailAddress_(message.getFrom());
  if (fromEmail) {
    return isInternalEmail_(fromEmail, internalIdentity) ? 'OUTBOUND' : 'INBOUND';
  }

  const recipients = extractEmailAddresses_([message.getTo(), message.getCc()].join(','));
  if (recipients.some(function(email) { return isInternalEmail_(email, internalIdentity); })) return 'INBOUND';
  return '';
}

function extractEmailAddresses_(value) {
  const text = String(value || '');
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  const seen = {};
  return matches.map(normalizeEmail_).filter(function(email) {
    if (!email || seen[email]) return false;
    seen[email] = true;
    return true;
  });
}

function loadSettings_(spreadsheet) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.settings);
  const values = sheet.getDataRange().getValues();
  const result = {};
  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][0] || '').trim();
    if (key) result[key] = values[i][1];
  }
  return result;
}

function loadCustomerMatchData_(spreadsheet) {
  const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts));

  return {
    customers: customers.filter(function(row) {
      const status = String(row.status || '').trim().toUpperCase();
      return !status || status === 'ACTIVE';
    }),
    contacts: contacts.filter(function(row) {
      return !isFalse_(row.active);
    })
  };
}

/**
 * 問い合わせ送信元から顧客・担当者を判定する。
 * 既存データに表示名・@付きドメイン・不可視文字などが混ざっても照合できるよう正規化して比較する。
 */
function matchCustomer_(fromEmail, data) {
  const extracted = extractEmailAddress_(fromEmail);
  const email = extracted || normalizeEmail_(fromEmail);
  if (!email || email.indexOf('@') < 0) {
    return { customerId: '', contactId: '', status: 'UNMATCHED' };
  }

  const exactContacts = data.contacts.filter(function(contact) {
    const contactEmail = extractEmailAddress_(contact.email) || normalizeEmail_(contact.email);
    return contactEmail === email;
  });

  if (exactContacts.length === 1) {
    return {
      customerId: String(exactContacts[0].customer_id || ''),
      contactId: String(exactContacts[0].contact_id || ''),
      status: 'EXACT_CONTACT'
    };
  }
  if (exactContacts.length > 1) {
    return { customerId: '', contactId: '', status: 'AMBIGUOUS' };
  }

  const domain = normalizeMatchDomain_(email.split('@').slice(-1)[0]);
  const domainCustomers = data.customers.filter(function(customer) {
    return normalizeMatchDomain_(customer.domain) === domain;
  });

  if (domainCustomers.length === 1) {
    return {
      customerId: String(domainCustomers[0].customer_id || ''),
      contactId: '',
      status: 'DOMAIN_MATCH'
    };
  }
  if (domainCustomers.length > 1) {
    return { customerId: '', contactId: '', status: 'AMBIGUOUS' };
  }
  return { customerId: '', contactId: '', status: 'UNMATCHED' };
}

function normalizeMatchDomain_(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\.+$/, '');
}

function createInquiry_(sheet, input) {
  const now = new Date();
  const inquiryId = createStableId_('INQ');
  const row = [
    inquiryId,
    input.matchedCustomer.customerId,
    input.matchedCustomer.contactId,
    input.gmailThreadId,
    input.subject || '',
    'NEW',
    'MEDIUM',
    '',
    '',
    '',
    '',
    '',
    input.matchedCustomer.status,
    input.receivedAt,
    input.receivedAt,
    now
  ];
  sheet.appendRow(row);
  return {
    inquiry_id: inquiryId,
    gmail_thread_id: input.gmailThreadId,
    _rowIndex: sheet.getLastRow()
  };
}

function updateInquiryLastMessageAt_(sheet, inquiry, messageDate) {
  if (!inquiry._rowIndex) return;
  sheet.getRange(inquiry._rowIndex, 15, 1, 2).setValues([[messageDate, new Date()]]);
}

function appendInquiryMessage_(sheet, input) {
  sheet.appendRow([
    createStableId_('MSG'),
    input.inquiryId,
    input.gmailMessageId,
    input.gmailThreadId,
    input.direction,
    input.fromEmail,
    input.toEmail || '',
    input.subject || '',
    input.body || '',
    input.sentAt,
    new Date()
  ]);
}

function loadColumnSet_(sheet, headerName) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return new Set();
  const headerIndex = values[0].indexOf(headerName);
  if (headerIndex < 0) throw new Error('Missing header: ' + headerName + ' in ' + sheet.getName());
  const set = new Set();
  for (let i = 1; i < values.length; i += 1) {
    if (values[i][headerIndex]) set.add(String(values[i][headerIndex]));
  }
  return set;
}

function loadRows_(sheet, keyHeader) {
  const rows = readSheetObjects_(sheet);
  const result = {};
  rows.forEach(function(row) {
    const key = String(row[keyHeader] || '');
    if (key) result[key] = row;
  });
  return result;
}

function readSheetObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function(value) { return String(value || '').trim(); });
  return values.slice(1).filter(function(row) {
    return row.some(function(value) { return value !== ''; });
  }).map(function(row, index) {
    const obj = { _rowIndex: index + 2 };
    headers.forEach(function(header, columnIndex) {
      if (header) obj[header] = row[columnIndex];
    });
    return obj;
  });
}

function requireSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error('Required sheet is missing: ' + sheetName);
  return sheet;
}

function extractEmailAddress_(value) {
  const text = String(value || '').trim();
  const angleMatch = text.match(/<([^<>]+@[^<>]+)>/);
  if (angleMatch) return normalizeEmail_(angleMatch[1]);
  const plainMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plainMatch ? normalizeEmail_(plainMatch[0]) : '';
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function isTrue_(value) {
  return value === true || String(value || '').trim().toUpperCase() === 'TRUE';
}

function isFalse_(value) {
  return value === false || String(value || '').trim().toUpperCase() === 'FALSE';
}

function createStableId_(prefix) {
  return prefix + '-' + Utilities.getUuid().split('-')[0].toUpperCase();
}


// --- bundled from InquiryReassessApi.gs ---
/**
 * 既存の問い合わせを現在の顧客・担当者マスタで再判定する。
 * 過去データでは direction が誤って保存されている可能性があるため、
 * 保存済み direction は信用せず、現在の自社メール判定ルールで顧客側送信メールを判定する。
 */
function reassessUnmatchedInquiriesV2() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  const inquiries = readSheetObjects_(inquirySheet);
  const targets = inquiries.filter(function(row) {
    const status = String(row.customer_match_status || 'UNMATCHED').trim().toUpperCase();
    return status === 'UNMATCHED' || status === 'AMBIGUOUS';
  });

  if (!targets.length) {
    return { checked: 0, matched: 0, remaining: 0, data: getInquiryScreenData() };
  }

  const settings = loadSettings_(spreadsheet);
  const receptionAddresses = getInquiryReceptionAddresses_(settings);
  const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);
  const customerData = loadCustomerMatchData_(spreadsheet);
  const targetIds = new Set(targets.map(function(row) { return String(row.inquiry_id || ''); }));
  const senderByInquiry = loadLatestCustomerSenderForReassessment_(spreadsheet, targetIds, internalIdentity);

  let matched = 0;
  let remaining = 0;

  targets.forEach(function(inquiry) {
    const inquiryId = String(inquiry.inquiry_id || '');
    const fromEmail = senderByInquiry[inquiryId] || '';
    if (!fromEmail) {
      remaining += 1;
      return;
    }

    const result = matchCustomer_(fromEmail, customerData);
    const isMatched = result.status === 'EXACT_CONTACT' || result.status === 'DOMAIN_MATCH';
    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      customer_id: isMatched ? result.customerId : '',
      contact_id: isMatched ? result.contactId : '',
      customer_match_status: result.status,
      updated_at: new Date()
    });

    if (isMatched) matched += 1;
    else remaining += 1;
  });

  return {
    checked: targets.length,
    matched: matched,
    remaining: remaining,
    data: getInquiryScreenData()
  };
}

/**
 * 再判定用に、各問い合わせの「最新の顧客側送信メール」を取得する。
 * 自社側の判定はInquiryMailImport.gsと同じisInternalEmail_を利用する。
 */
function loadLatestCustomerSenderForReassessment_(spreadsheet, targetIds, internalIdentity) {
  const rows = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages));
  const result = {};

  rows.forEach(function(row) {
    const inquiryId = String(row.inquiry_id || '');
    if (!targetIds.has(inquiryId)) return;

    const fromEmail = extractEmailAddress_(row.from_email) || normalizeEmail_(row.from_email);
    if (!fromEmail) return;

    // 自社送信は顧客判定に使わない。過去にINBOUNDと誤保存された行もここで除外する。
    if (isInternalEmail_(fromEmail, internalIdentity)) return;

    const recipients = extractEmailAddressesForReassessment_([row.to_email].join(','));
    const targetsInternal = recipients.some(function(email) {
      return isInternalEmail_(email, internalIdentity);
    });

    // Toが取込時に欠けている古いデータもあるため、Fromが自社でなければ候補には残す。
    // Toが存在する場合は、自社側宛のメールだけを受信候補とする。
    if (recipients.length && !targetsInternal) return;

    const time = toInquiryTime_(row.sent_at);
    if (!result[inquiryId] || time >= result[inquiryId].time) {
      result[inquiryId] = { email: fromEmail, time: time };
    }
  });

  const senderByInquiry = {};
  Object.keys(result).forEach(function(inquiryId) {
    senderByInquiry[inquiryId] = result[inquiryId].email;
  });
  return senderByInquiry;
}

function extractEmailAddressesForReassessment_(value) {
  const text = String(value || '');
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  const seen = {};
  const result = [];
  matches.forEach(function(value) {
    const email = normalizeEmail_(value);
    if (email && !seen[email]) {
      seen[email] = true;
      result.push(email);
    }
  });
  return result;
}


// --- bundled from InquiryReplyApi.gs ---
/**
 * 問い合わせの最新受信メールへ返信する。
 * Gmail上の同一スレッドを維持し、送信後はInquiryMessagesへOUTBOUNDとして記録する。
 */
function sendInquiryReply(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const body = String(input.body || '').trim();
  const cc = normalizeInquiryReplyCc_(input.cc);
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!body) throw new Error('返信本文を入力してください。');
  if (body.length > 20000) throw new Error('返信本文が長すぎます。20,000文字以内にしてください。');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
    return String(row.inquiry_id || '') === inquiryId;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const target = findLatestInboundReplyTarget_(spreadsheet, inquiryId);
  if (!target || !target.gmailMessageId) {
    throw new Error('返信元となる受信メールが見つかりません。');
  }

  const sourceMessage = GmailApp.getMessageById(target.gmailMessageId);
  if (!sourceMessage) throw new Error('Gmail上の返信元メールが見つかりません。');

  const thread = sourceMessage.getThread();
  const beforeIds = {};
  thread.getMessages().forEach(function(message) {
    beforeIds[message.getId()] = true;
  });

  // GmailMessage.reply() を使い、Reply-Toと元スレッドを維持する。
  // CCは画面で確認・編集した値だけを追加する。
  if (cc.length) {
    sourceMessage.reply(body, { cc: cc.join(',') });
  } else {
    sourceMessage.reply(body);
  }

  const sentMessage = findNewThreadMessageAfterReply_(thread, beforeIds);
  appendOutboundReply_(spreadsheet, inquiry, target, body, sentMessage);

  const sentAt = sentMessage ? sentMessage.getDate() : new Date();
  writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
    last_message_at: sentAt,
    updated_at: new Date()
  });

  return {
    recipient: target.replyTo || target.fromEmail,
    cc: cc,
    sentAt: formatDateForClient_(sentAt, "yyyy-MM-dd'T'HH:mm:ss"),
    messages: getInquiryMessages(inquiryId),
    inquiryData: getInquiryScreenData()
  };
}

/** 最新の受信メールを返信対象として返す。 */
function findLatestInboundReplyTarget_(spreadsheet, inquiryId) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const rows = readSheetObjects_(sheet).filter(function(row) {
    return String(row.inquiry_id || '') === inquiryId &&
      String(row.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
      String(row.gmail_message_id || '').trim();
  });
  if (!rows.length) return null;
  rows.sort(function(a, b) {
    return toReplyTime_(b.sent_at) - toReplyTime_(a.sent_at);
  });
  const row = rows[0];
  let replyTo = '';
  let sourceCc = '';
  try {
    const gmailMessage = GmailApp.getMessageById(String(row.gmail_message_id || ''));
    if (gmailMessage) {
      replyTo = String(gmailMessage.getReplyTo() || '').trim();
      sourceCc = String(gmailMessage.getCc() || '').trim();
    }
  } catch (ignore) {}
  return {
    gmailMessageId: String(row.gmail_message_id || ''),
    fromEmail: String(row.from_email || ''),
    replyTo: replyTo,
    sourceCc: sourceCc
  };
}

/** 画面入力されたCCを正規化・検証する。 */
function normalizeInquiryReplyCc_(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  if (text.length > 2000) throw new Error('CCが長すぎます。');

  const tokens = text.split(/[\n,;]+/).map(function(item) {
    return String(item || '').trim();
  }).filter(function(item) { return !!item; });
  const result = [];
  const seen = {};
  tokens.forEach(function(token) {
    const email = extractEmailAddress_(token) || normalizeEmail_(token);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('CCのメールアドレスを確認してください: ' + token);
    }
    if (!seen[email]) {
      seen[email] = true;
      result.push(email);
    }
  });
  return result;
}

/** 返信後にスレッドへ追加されたメールを特定する。 */
function findNewThreadMessageAfterReply_(thread, beforeIds) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) Utilities.sleep(400 * attempt);
    thread.refresh();
    const newMessages = thread.getMessages().filter(function(message) {
      return !beforeIds[message.getId()];
    });
    if (newMessages.length) {
      newMessages.sort(function(a, b) { return b.getDate().getTime() - a.getDate().getTime(); });
      return newMessages[0];
    }
  }
  // メール送信自体は成功しているため、履歴特定失敗を送信失敗として扱わない。
  return null;
}

function appendOutboundReply_(spreadsheet, inquiry, target, body, sentMessage) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const sentAt = sentMessage ? sentMessage.getDate() : new Date();
  const gmailMessageId = sentMessage ? sentMessage.getId() : '';
  const gmailThreadId = sentMessage
    ? sentMessage.getThread().getId()
    : String(inquiry.gmail_thread_id || '');
  const fromEmail = sentMessage
    ? extractEmailAddress_(sentMessage.getFrom())
    : String(Session.getEffectiveUser().getEmail() || '');
  const toEmail = sentMessage
    ? sentMessage.getTo()
    : (target.replyTo || target.fromEmail);
  const subject = sentMessage
    ? sentMessage.getSubject()
    : String(inquiry.subject || '');

  sheet.appendRow([
    createStableId_('MSG'),
    String(inquiry.inquiry_id || ''),
    gmailMessageId,
    gmailThreadId,
    'OUTBOUND',
    fromEmail,
    toEmail,
    subject,
    body,
    sentAt,
    new Date()
  ]);
}

function toReplyTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}


// --- bundled from InquiryReplyInfoApi.gs ---
/** 返信画面で送信前に実際の返信先と初期CCを確認するための情報を返す。 */
function getInquiryReplyInfo(inquiryId) {
  const id = String(inquiryId || '').trim();
  if (!id) throw new Error('inquiryId is required.');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const target = findLatestInboundReplyTarget_(spreadsheet, id);
  if (!target) return null;

  const rows = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages)).filter(function(row) {
    return String(row.inquiry_id || '') === id && String(row.gmail_message_id || '') === target.gmailMessageId;
  });
  const row = rows.length ? rows[0] : {};
  const recipient = target.replyTo || target.fromEmail;
  return {
    recipient: recipient,
    fromEmail: target.fromEmail,
    cc: buildDefaultInquiryReplyCc_(spreadsheet, target.sourceCc, recipient),
    subject: String(row.subject || ''),
    sentAt: formatDateForClient_(row.sent_at, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

/**
 * 元メールのCCを返信画面の初期値にする。
 * 主宛先との重複と、自社ドメイン・社内メンバー・問い合わせ受付アドレスは除外する。
 */
function buildDefaultInquiryReplyCc_(spreadsheet, sourceCc, recipient) {
  const settings = loadSettings_(spreadsheet);
  const receptionAddresses = getInquiryReceptionAddresses_(settings);
  const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);
  const mainRecipient = extractEmailAddress_(recipient) || normalizeEmail_(recipient);
  const seen = {};
  const result = [];

  extractEmailAddresses_(sourceCc).forEach(function(email) {
    if (!email || email === mainRecipient || seen[email]) return;
    if (isInternalEmail_(email, internalIdentity)) return;
    seen[email] = true;
    result.push(email);
  });
  return result;
}


// --- bundled from InquirySchema.gs ---
/**
 * Inquiriesの「概要」と「詳細」の役割を分離するための軽量マイグレーション。
 *
 * 旧仕様:
 * - summary = 問い合わせの詳細説明
 *
 * 新仕様:
 * - summary = 一覧・見出し用の短い概要（初期値はメール件名）
 * - detail  = 旧summary相当の詳細説明
 *
 * 既存シートにdetail列がない場合だけ、旧summaryをdetailへ退避し、
 * summaryをメール件名で初期化する。以後は空のsummaryだけ件名で補完する。
 */
function ensureInquirySummaryDetailSchema_(spreadsheet) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Inquiriesのヘッダーがありません。');

  let headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const subjectIndex = headers.indexOf('subject');
  const summaryIndex = headers.indexOf('summary');
  if (subjectIndex < 0 || summaryIndex < 0) {
    throw new Error('Inquiries に subject / summary 列がありません。');
  }

  let detailIndex = headers.indexOf('detail');
  const rowCount = Math.max(0, sheet.getLastRow() - 1);

  if (detailIndex < 0) {
    sheet.insertColumnAfter(lastColumn);
    lastColumn += 1;
    detailIndex = lastColumn - 1;
    sheet.getRange(1, lastColumn).setValue('detail');

    if (rowCount > 0) {
      const oldSummaries = sheet.getRange(2, summaryIndex + 1, rowCount, 1).getValues();
      const subjects = sheet.getRange(2, subjectIndex + 1, rowCount, 1).getValues();
      sheet.getRange(2, detailIndex + 1, rowCount, 1).setValues(oldSummaries);
      sheet.getRange(2, summaryIndex + 1, rowCount, 1).setValues(subjects.map(function(row) {
        return [String(row[0] || '')];
      }));
    }
  } else if (rowCount > 0) {
    // 新規取込直後などsummaryが空の場合は、件名を初期値として補完する。
    const summaries = sheet.getRange(2, summaryIndex + 1, rowCount, 1).getValues();
    const subjects = sheet.getRange(2, subjectIndex + 1, rowCount, 1).getValues();
    let changed = false;
    summaries.forEach(function(row, index) {
      if (!String(row[0] || '').trim() && String(subjects[index][0] || '').trim()) {
        row[0] = String(subjects[index][0] || '');
        changed = true;
      }
    });
    if (changed) sheet.getRange(2, summaryIndex + 1, rowCount, 1).setValues(summaries);
  }

  return sheet;
}


// --- bundled from InquirySplitApi.gs ---
/**
 * 同一Gmailスレッド内で別件が始まった場合、指定した受信メール以降を新しいInquiryへ分離する。
 * Gmailスレッドは同じまま、業務上の問い合わせ単位だけを分ける。
 */
function splitInquiryFromMessage(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const messageId = String(input.messageId || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!messageId) throw new Error('messageId is required.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
    const messageSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
    const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('分離元の問い合わせが見つかりません。');

    const messages = readSheetObjects_(messageSheet).filter(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    }).sort(function(a, b) {
      const diff = toInquirySplitTime_(a.sent_at) - toInquirySplitTime_(b.sent_at);
      return diff || Number(a._rowIndex || 0) - Number(b._rowIndex || 0);
    });

    const boundaryIndex = messages.findIndex(function(row) {
      return String(row.message_id || '') === messageId;
    });
    if (boundaryIndex < 0) throw new Error('分離開始メールが見つかりません。');

    const boundary = messages[boundaryIndex];
    if (String(boundary.direction || 'INBOUND').toUpperCase() !== 'INBOUND') {
      throw new Error('別問い合わせの開始位置には受信メールを選択してください。');
    }
    if (boundaryIndex === 0) {
      throw new Error('最初のメールから分離すると元の問い合わせが空になるため分離できません。');
    }

    const gmailThreadId = String(boundary.gmail_thread_id || inquiry.gmail_thread_id || '');
    if (!gmailThreadId) throw new Error('GmailスレッドIDがないため分離できません。');

    const movedMessages = messages.slice(boundaryIndex);
    const remainingMessages = messages.slice(0, boundaryIndex);
    const matchedCustomer = matchCustomer_(String(boundary.from_email || ''), loadCustomerMatchData_(spreadsheet));

    const newInquiry = createInquiry_(inquirySheet, {
      gmailThreadId: gmailThreadId,
      subject: String(boundary.subject || inquiry.subject || ''),
      matchedCustomer: matchedCustomer,
      receivedAt: boundary.sent_at || new Date()
    });

    movedMessages.forEach(function(row) {
      writeRowUpdates_(messageSheet, row._rowIndex, {
        inquiry_id: newInquiry.inquiry_id
      });
    });

    const sourceLast = remainingMessages[remainingMessages.length - 1];
    const newLast = movedMessages[movedMessages.length - 1];
    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      last_message_at: sourceLast ? sourceLast.sent_at : inquiry.received_at,
      updated_at: new Date()
    });
    writeRowUpdates_(inquirySheet, newInquiry._rowIndex, {
      last_message_at: newLast ? newLast.sent_at : boundary.sent_at,
      updated_at: new Date()
    });

    return {
      sourceInquiryId: inquiryId,
      newInquiryId: newInquiry.inquiry_id,
      movedCount: movedMessages.length,
      inquiryData: getInquiryScreenData(),
      sourceMessages: getInquiryMessages(inquiryId),
      newMessages: getInquiryMessages(newInquiry.inquiry_id)
    };
  } finally {
    lock.releaseLock();
  }
}

function toInquirySplitTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}


// --- bundled from MasterApi.gs ---
const MASTER_SETTING_DEFINITIONS = [
  {
    key: 'INQUIRY_GROUP_ADDRESS',
    defaultValue: '',
    description: '問い合わせ受付アドレス。複数ある場合はカンマ、改行、セミコロン区切りで指定します。'
  },
  {
    key: 'MAIL_SEARCH_QUERY',
    defaultValue: 'to:{GROUP_ADDRESS} newer_than:30d',
    description: 'Gmail検索条件。複数の受付アドレスがある場合、to:{GROUP_ADDRESS} は各受付アドレスへのOR条件へ展開します。'
  },
  {
    key: 'MAIL_IMPORT_MAX_THREADS',
    defaultValue: '50',
    description: '1回の取込処理で検索する最大スレッド数。'
  },
  {
    key: 'MAIL_IMPORT_ENABLED',
    defaultValue: 'FALSE',
    description: 'TRUEの場合のみメール自動取込を実行します。'
  },
  {
    key: 'INTERNAL_MAIL_DOMAINS',
    defaultValue: '',
    description: '自社送信と判定するメールドメイン。複数ある場合はカンマ、改行、セミコロン区切りで指定します。例: example.co.jp,example.com'
  },
  {
    key: 'INQUIRY_EXCLUDED_DOMAINS',
    defaultValue: '',
    description: '問い合わせ一覧・ダッシュボードの対象外にする送信元ドメイン。複数指定可。example.com を指定すると、そのサブドメインも対象外になります。'
  }
];

const MASTER_SETTING_KEYS = MASTER_SETTING_DEFINITIONS.map(function(item) { return item.key; });

/**
 * マスタ管理画面の初期表示データを返す。
 */
function getMasterScreenData() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const categorySheet = ensureInquiryCategorySheet_(spreadsheet);
  return {
    customers: readSheetObjects_(requireSheet_(spreadsheet, 'Customers')).map(serializeCustomerMaster_),
    contacts: readSheetObjects_(requireSheet_(spreadsheet, 'CustomerContacts')).map(serializeContactMaster_),
    members: readSheetObjects_(requireSheet_(spreadsheet, 'Members')).map(serializeMemberMaster_),
    categories: readSheetObjects_(categorySheet).map(serializeCategoryMaster_).sort(sortByDisplayOrder_),
    settings: buildSystemSettingsForScreen_(requireSheet_(spreadsheet, 'Settings'))
  };
}

/**
 * 画面で管理可能な設定は、Settingsシートの状態にかかわらず必ず返す。
 * シートに値が存在する場合はその値・説明を優先する。
 */
function buildSystemSettingsForScreen_(sheet) {
  const rows = readSheetObjects_(sheet);
  const rowByKey = {};
  rows.forEach(function(row) {
    const key = String(row.setting_key || '').trim();
    if (key) rowByKey[key] = row;
  });

  return MASTER_SETTING_DEFINITIONS.map(function(definition) {
    const row = rowByKey[definition.key] || {};
    const hasValue = Object.prototype.hasOwnProperty.call(row, 'setting_value') && row.setting_value !== '';
    const rawValue = hasValue ? row.setting_value : definition.defaultValue;
    return {
      key: definition.key,
      value: normalizeSystemSettingValueForScreen_(definition.key, rawValue),
      description: String(row.description || definition.description),
      updatedAt: formatDateForClient_(row.updated_at, "yyyy-MM-dd'T'HH:mm:ss")
    };
  });
}

/**
 * Google Sheetsでは TRUE / FALSE がBooleanとして返る場合があるため、
 * 画面が期待する文字列形式へ正規化する。
 */
function normalizeSystemSettingValueForScreen_(key, value) {
  if (key === 'MAIL_IMPORT_ENABLED') {
    return isTrue_(value) ? 'TRUE' : 'FALSE';
  }
  return String(value == null ? '' : value);
}

function saveCustomerMaster(input) {
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = requireSheet_(spreadsheet, 'Customers');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('顧客名は必須です。');
  const id = saveMasterRow_(sheet, 'customer_id', String(input.id || ''), 'CUS', {
    customer_name: name,
    domain: normalizeDomain_(input.domain),
    status: String(input.status || 'ACTIVE') === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    note: String(input.note || ''),
    updated_at: new Date()
  });
  return { id: id, data: getMasterScreenData() };
}

function saveContactMaster(input) {
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = requireSheet_(spreadsheet, 'CustomerContacts');
  const customerId = String(input.customerId || '').trim();
  const email = normalizeEmail_(input.email);
  if (!customerId) throw new Error('顧客は必須です。');
  if (!readSheetObjects_(requireSheet_(spreadsheet, 'Customers')).some(function(row) { return String(row.customer_id || '') === customerId; })) {
    throw new Error('選択した顧客が存在しません。');
  }
  if (!email) throw new Error('メールアドレスは必須です。');
  const duplicate = readSheetObjects_(sheet).find(function(row) {
    return normalizeEmail_(row.email) === email && String(row.contact_id || '') !== String(input.id || '');
  });
  if (duplicate) throw new Error('同じメールアドレスの顧客担当者が既に登録されています。');
  const id = saveMasterRow_(sheet, 'contact_id', String(input.id || ''), 'CON', {
    customer_id: customerId,
    contact_name: String(input.name || '').trim(),
    email: email,
    phone: String(input.phone || '').trim(),
    active: input.active !== false,
    updated_at: new Date()
  });
  return { id: id, data: getMasterScreenData() };
}

function saveMemberMaster(input) {
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = requireSheet_(spreadsheet, 'Members');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('メンバー名は必須です。');
  const id = saveMasterRow_(sheet, 'member_id', String(input.id || ''), 'MEM', {
    member_name: name,
    email: normalizeEmail_(input.email),
    active: input.active !== false,
    display_order: toOptionalNumber_(input.displayOrder),
    updated_at: new Date()
  });
  return { id: id, data: getMasterScreenData() };
}

function saveInquiryCategoryMaster(input) {
  input = input || {};
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = ensureInquiryCategorySheet_(spreadsheet);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('分類名は必須です。');
  const duplicate = readSheetObjects_(sheet).find(function(row) {
    return String(row.category_name || '').trim().toLowerCase() === name.toLowerCase() && String(row.category_id || '') !== String(input.id || '');
  });
  if (duplicate) throw new Error('同じ分類名が既に登録されています。');
  const id = saveMasterRow_(sheet, 'category_id', String(input.id || ''), 'CAT', {
    category_name: name,
    active: input.active !== false,
    display_order: toOptionalNumber_(input.displayOrder),
    updated_at: new Date()
  });
  return { id: id, data: getMasterScreenData() };
}

function saveSystemSetting(input) {
  input = input || {};
  const key = String(input.key || '').trim();
  if (MASTER_SETTING_KEYS.indexOf(key) < 0) throw new Error('この設定は画面から変更できません。');
  let value = String(input.value == null ? '' : input.value).trim();
  if (key === 'MAIL_IMPORT_ENABLED') value = value.toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
  if (key === 'MAIL_IMPORT_MAX_THREADS') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 500) throw new Error('最大スレッド数は1〜500で指定してください。');
    value = String(Math.floor(n));
  }
  if (key === 'INQUIRY_GROUP_ADDRESS') value = normalizeEmailListSetting_(value);
  if (key === 'INTERNAL_MAIL_DOMAINS' || key === 'INQUIRY_EXCLUDED_DOMAINS') value = normalizeDomainListSetting_(value);

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = requireSheet_(spreadsheet, 'Settings');
  const rows = readSheetObjects_(sheet);
  let row = rows.find(function(item) { return String(item.setting_key || '') === key; });

  // 画面定義に存在する設定がシートから欠けている場合は、その場で補完する。
  if (!row) {
    const definition = MASTER_SETTING_DEFINITIONS.find(function(item) { return item.key === key; });
    sheet.appendRow([key, value, definition ? definition.description : '', new Date()]);
  } else {
    writeRowUpdates_(sheet, row._rowIndex, { setting_value: value, updated_at: new Date() });
  }
  return getMasterScreenData();
}

function saveMasterRow_(sheet, idHeader, requestedId, prefix, updates) {
  const rows = readSheetObjects_(sheet);
  let id = requestedId;
  let row = id ? rows.find(function(item) { return String(item[idHeader] || '') === id; }) : null;
  if (id && !row) throw new Error('更新対象が見つかりません。');
  if (!row) {
    id = createStableId_(prefix);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const values = headers.map(function(header) {
      if (header === idHeader) return id;
      return Object.prototype.hasOwnProperty.call(updates, header) ? updates[header] : '';
    });
    sheet.appendRow(values);
  } else {
    writeRowUpdates_(sheet, row._rowIndex, updates);
  }
  return id;
}

function writeRowUpdates_(sheet, rowIndex, updates) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  headers.forEach(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(updates, header)) values[index] = updates[header];
  });
  sheet.getRange(rowIndex, 1, 1, values.length).setValues([values]);
}

function ensureInquiryCategorySheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('InquiryCategories');
  if (sheet) return sheet;
  sheet = spreadsheet.insertSheet('InquiryCategories');
  sheet.getRange(1, 1, 1, 5).setValues([['category_id', 'category_name', 'active', 'display_order', 'updated_at']]);
  sheet.setFrozenRows(1);
  return sheet;
}

function serializeCustomerMaster_(row) {
  return { id: String(row.customer_id || ''), name: String(row.customer_name || ''), domain: String(row.domain || ''), status: String(row.status || 'ACTIVE'), note: String(row.note || '') };
}
function serializeContactMaster_(row) {
  return { id: String(row.contact_id || ''), customerId: String(row.customer_id || ''), name: String(row.contact_name || ''), email: String(row.email || ''), phone: String(row.phone || ''), active: !isFalse_(row.active) };
}
function serializeMemberMaster_(row) {
  return { id: String(row.member_id || ''), name: String(row.member_name || ''), email: String(row.email || ''), active: !isFalse_(row.active), displayOrder: row.display_order === '' ? '' : Number(row.display_order) };
}
function serializeCategoryMaster_(row) {
  return { id: String(row.category_id || ''), name: String(row.category_name || ''), active: !isFalse_(row.active), displayOrder: row.display_order === '' ? '' : Number(row.display_order) };
}
function sortByDisplayOrder_(a, b) {
  const av = a.displayOrder === '' ? 999999 : Number(a.displayOrder);
  const bv = b.displayOrder === '' ? 999999 : Number(b.displayOrder);
  return av - bv || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
}
function normalizeDomain_(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}
function normalizeEmailListSetting_(value) {
  const seen = {};
  return String(value || '').split(/[\n,;]+/).map(function(item) {
    return normalizeEmail_(item);
  }).filter(function(email) {
    if (!email) return false;
    if (email.indexOf('@') < 1) throw new Error('問い合わせ受付アドレスに正しいメールアドレスを指定してください: ' + email);
    if (seen[email]) return false;
    seen[email] = true;
    return true;
  }).join(', ');
}
function normalizeDomainListSetting_(value) {
  const seen = {};
  return String(value || '').split(/[\n,;]+/).map(function(item) {
    return normalizeDomain_(item);
  }).filter(function(domain) {
    if (!domain || seen[domain]) return false;
    seen[domain] = true;
    return true;
  }).join(', ');
}
function toOptionalNumber_(value) {
  if (value === '' || value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('表示順は数値で指定してください。');
  return n;
}


// --- bundled from UserAccess.gs ---
/**
 * Workspaceユーザー照合。認可の正本はUsersシートとし、クライアント入力を信用しない。
 * アプリ全体の強制適用は全公開APIのガード追加・開発環境の本人識別試験後に有効化する。
 */
const USER_ACCESS_ROLES_ = ['ADMIN', 'USER'];

function normalizeAccessEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

/** 同一Workspaceドメイン構成での本人識別を検証する診断API（業務データは返さない）。 */
function checkWorkspaceIdentity() {
  const email = normalizeAccessEmail_(Session.getActiveUser().getEmail());
  return {
    emailAvailable: !!email,
    email: email,
    matched: !!(email && findAccessUser_(email)),
    role: email ? ((findAccessUser_(email) || {}).role || '') : ''
  };
}

function ensureUsersSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('Users');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Users');
    sheet.getRange(1, 1, 1, 7).setValues([[
      'user_id', 'user_name', 'email', 'role', 'active', 'member_id', 'updated_at'
    ]]);
    sheet.setFrozenRows(1);
  }
  validateCustomerSheetHeaders_(sheet, [
    'user_id', 'user_name', 'email', 'role', 'active', 'member_id', 'updated_at'
  ]);
  return sheet;
}

/** Usersシートへの初回管理者登録は導入手順に従い管理者が直接行う。 */
function findAccessUser_(email) {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = spreadsheet.getSheetByName('Users');
  if (!sheet) return null;
  const normalized = normalizeAccessEmail_(email);
  if (!normalized) return null;
  const matches = readSheetObjects_(sheet).filter(function(row) {
    return normalizeAccessEmail_(row.email) === normalized;
  });
  if (matches.length !== 1) return null;
  const row = matches[0];
  const role = String(row.role || '').trim().toUpperCase();
  if (USER_ACCESS_ROLES_.indexOf(role) < 0 || !isTrue_(row.active)) return null;
  return { id: String(row.user_id || ''), name: String(row.user_name || ''), email: normalized, role: role };
}

/** 今後すべてのWeb業務APIの冒頭で呼ぶ（漏れがあればアクセス制限不完全）。 */
function requireAccessUser_(requiredRole) {
  const email = normalizeAccessEmail_(Session.getActiveUser().getEmail());
  if (!email) throw new Error('Google Workspaceのログインユーザーを確認できません。管理者へお問い合わせください。');
  const user = findAccessUser_(email);
  if (!user) throw new Error('このアカウントには利用権限がありません。管理者へお問い合わせください。');
  if (requiredRole === 'ADMIN' && user.role !== 'ADMIN') {
    throw new Error('この操作は管理者のみ実行できます。');
  }
  return user;
}

/** 管理者専用UsersマスタAPI。認証強制適用前でも管理者以外は呼び出せない。 */
function getUsersMasterData() {
  requireAccessUser_('ADMIN');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  return readSheetObjects_(ensureUsersSheet_(spreadsheet)).map(function(row) {
    return {
      id: String(row.user_id || ''),
      name: String(row.user_name || ''),
      email: normalizeAccessEmail_(row.email),
      role: String(row.role || ''),
      active: isTrue_(row.active),
      memberId: String(row.member_id || '')
    };
  });
}

function saveAccessUser(input) {
  requireAccessUser_('ADMIN');
  input = input || {};
  const email = normalizeAccessEmail_(input.email);
  const name = String(input.name || '').trim();
  const role = String(input.role || '').trim().toUpperCase();
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('氏名と正しいメールアドレスが必要です。');
  if (USER_ACCESS_ROLES_.indexOf(role) < 0) throw new Error('権限が不正です。');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = ensureUsersSheet_(spreadsheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('更新が競合しています。');
  try {
    const rows = readSheetObjects_(sheet);
    const id = String(input.id || '').trim();
    const duplicate = rows.find(function(row) {
      return normalizeAccessEmail_(row.email) === email && String(row.user_id || '') !== id;
    });
    if (duplicate) throw new Error('同じメールアドレスが既に登録されています。');
    const existing = id ? rows.find(function(row) { return String(row.user_id || '') === id; }) : null;
    if (id && !existing) throw new Error('更新対象が見つかりません。');
    const active = input.active !== false;
    // 最後の有効な管理者を無効化/降格しない。
    const remainingAdmins = rows.filter(function(row) {
      if (existing && String(row.user_id || '') === id) return active && role === 'ADMIN';
      return isTrue_(row.active) && String(row.role || '').toUpperCase() === 'ADMIN';
    });
    if (remainingAdmins.length < 1) throw new Error('有効な管理者を最低1名残してください。');
    const memberId = String(input.memberId || '').trim();
    if (memberId && !readSheetObjects_(requireSheet_(spreadsheet, 'Members')).some(function(row) {
      return String(row.member_id || '') === memberId;
    })) throw new Error('社内メンバーが存在しません。');
    const userId = saveMasterRow_(sheet, 'user_id', id, 'USR', {
      user_name: name, email: email, role: role, active: active,
      member_id: memberId, updated_at: new Date()
    });
    return { id: userId, users: getUsersMasterData() };
  } finally {
    lock.releaseLock();
  }
}


/**
 * 既存MembersからUsersへ登録する候補を返す。顧客担当者は対象に含めない。
 * 既存Usersは上書きせず、未登録の有効メンバーだけを候補にする。
 */
function previewMembersForUserImport() {
  const admin = requireAccessUser_('ADMIN');
  const adminDomain = admin.email.split('@')[1];
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const existing = readSheetObjects_(ensureUsersSheet_(spreadsheet));
  const used = {};
  existing.forEach(function(row) { used[normalizeAccessEmail_(row.email)] = true; });
  const candidates = [];
  const skipped = [];
  const seen = {};
  readSheetObjects_(requireSheet_(spreadsheet, 'Members')).forEach(function(row) {
    const id = String(row.member_id || '').trim();
    const email = normalizeAccessEmail_(row.email);
    const name = String(row.member_name || '').trim();
    if (!isTrue_(row.active) || !id || !name || !email || email.split('@')[1] !== adminDomain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped.push({memberId:id,reason:'無効・メール未設定・ドメイン不一致など'});
      return;
    }
    if (used[email] || seen[email]) {
      skipped.push({memberId:id,reason:'ユーザー登録済み、またはメール重複'});
      return;
    }
    seen[email] = true;
    candidates.push({memberId:id,name:name,email:email});
  });
  return {candidates:candidates,skipped:skipped};
}

/** 管理者が画面で確認して選択した社内メンバーのみ、一般ユーザーとして追加。 */
function importMembersAsUsers(input) {
  const admin = requireAccessUser_('ADMIN');
  const adminDomain = admin.email.split('@')[1];
  const ids = Array.isArray(input && input.memberIds) ? input.memberIds.map(String) : [];
  const selected = {};
  ids.forEach(function(id) { if (id) selected[id] = true; });
  if (!Object.keys(selected).length) throw new Error('登録する社内メンバーを選択してください。');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('登録処理が競合しました。');
  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const usersSheet = ensureUsersSheet_(spreadsheet);
    const users = readSheetObjects_(usersSheet);
    const existingEmails = {};
    users.forEach(function(row) { existingEmails[normalizeAccessEmail_(row.email)] = true; });
    const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
    const matches = members.filter(function(row) { return selected[String(row.member_id || '')]; });
    if (matches.length !== Object.keys(selected).length) throw new Error('選択されたメンバーが見つかりません。再読み込みしてください。');
    const newUsers = [];
    const seen = {};
    matches.forEach(function(row) {
      const email = normalizeAccessEmail_(row.email);
      const name = String(row.member_name || '').trim();
      const memberId = String(row.member_id || '');
      if (!isTrue_(row.active) || !name || !email || email.split('@')[1] !== adminDomain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('取込不可のメンバーが選択されています: '+memberId);
      if (existingEmails[email] || seen[email]) throw new Error('ユーザー登録済みまたはメール重複: '+email);
      seen[email] = true;
      newUsers.push([createStableId_('USR'),name,email,'USER',true,memberId,new Date()]);
    });
    const headers = usersSheet.getRange(1,1,1,usersSheet.getLastColumn()).getValues()[0];
    const fields = ['user_id','user_name','email','role','active','member_id','updated_at'];
    newUsers.forEach(function(values) {
      const data = {};
      fields.forEach(function(field,i) { data[field] = values[i]; });
      usersSheet.appendRow(headers.map(function(header) { return Object.prototype.hasOwnProperty.call(data,header)?data[header]:''; }));
    });
    return {created:newUsers.length,users:readSheetObjects_(usersSheet).map(function(row) {
      return {id:String(row.user_id||''),name:String(row.user_name||''),email:normalizeAccessEmail_(row.email),role:String(row.role||''),active:isTrue_(row.active),memberId:String(row.member_id||'')};
    })};
  } finally { lock.releaseLock(); }
}

