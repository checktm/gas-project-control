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
