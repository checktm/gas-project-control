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
  if (key === 'INTERNAL_MAIL_DOMAINS') value = normalizeDomainListSetting_(value);

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
