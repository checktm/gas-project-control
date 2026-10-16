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
