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
