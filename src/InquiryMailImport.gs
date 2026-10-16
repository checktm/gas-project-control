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
  maxThreads: 'MAIL_IMPORT_MAX_THREADS'
};

/**
 * Googleグループ宛にGmailへ配信されたメールを問い合わせとして取り込む。
 * Settings の MAIL_IMPORT_ENABLED が TRUE の場合のみ実行する。
 */
function importInquiryEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Inquiry mail import is already running.');
    return { imported: 0, skipped: 0, errors: 0, reason: 'LOCKED' };
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const settings = loadSettings_(spreadsheet);

    if (!isTrue_(settings[INQUIRY_SETTINGS.enabled])) {
      return { imported: 0, skipped: 0, errors: 0, reason: 'DISABLED' };
    }

    const groupAddress = normalizeEmail_(settings[INQUIRY_SETTINGS.groupAddress]);
    if (!groupAddress) {
      throw new Error('INQUIRY_GROUP_ADDRESS is not configured.');
    }

    const query = buildInquiryMailQuery_(settings, groupAddress);
    const maxThreads = Math.max(1, Number(settings[INQUIRY_SETTINGS.maxThreads]) || 50);
    const threads = GmailApp.search(query, 0, maxThreads).slice().reverse();

    const messageSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
    const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
    const importedMessageIds = loadColumnSet_(messageSheet, 'gmail_message_id');
    const inquiryByThreadId = loadRows_(inquirySheet, 'gmail_thread_id');
    const customerData = loadCustomerMatchData_(spreadsheet);
    const internalAddresses = loadInternalMailAddresses_(groupAddress);

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

          // Gmail検索結果はスレッド単位なので、同一スレッド内の各メールを
          // From / To / Cc と自社アドレス集合から受信・送信に分類する。
          const direction = classifyInquiryMessageDirection_(message, internalAddresses);
          if (!direction) {
            skipped += 1;
            return;
          }

          const gmailThreadId = thread.getId();
          const fromEmail = extractEmailAddress_(message.getFrom());
          let inquiry = inquiryByThreadId[gmailThreadId];

          // 問い合わせは顧客からの受信を起点に作成する。
          // OUTBOUNDだけが先に見つかった場合は、後続のINBOUNDで作成するためスキップする。
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

    return { imported: imported, skipped: skipped, errors: errors, query: query };
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
  const groupAddress = normalizeEmail_(settings[INQUIRY_SETTINGS.groupAddress]);
  if (!groupAddress) {
    throw new Error('INQUIRY_GROUP_ADDRESS is not configured.');
  }

  const query = buildInquiryMailQuery_(settings, groupAddress);
  const threads = GmailApp.search(query, 0, 10);
  const internalAddresses = loadInternalMailAddresses_(groupAddress);
  const result = [];

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      const direction = classifyInquiryMessageDirection_(message, internalAddresses);
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
 * 5分間隔の時間主導トリガーを作成する。設定確認後に一度だけ手動実行する。
 */
function installInquiryMailImportTrigger() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const settings = loadSettings_(spreadsheet);
  if (!isTrue_(settings[INQUIRY_SETTINGS.enabled])) {
    throw new Error('MAIL_IMPORT_ENABLED must be TRUE before installing the trigger.');
  }
  if (!normalizeEmail_(settings[INQUIRY_SETTINGS.groupAddress])) {
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

function buildInquiryMailQuery_(settings, groupAddress) {
  const template = String(settings[INQUIRY_SETTINGS.searchQuery] || 'to:{GROUP_ADDRESS} newer_than:30d').trim();
  return template.replace(/\{GROUP_ADDRESS\}/g, groupAddress);
}

/**
 * 自社側として扱うメールアドレスを集める。
 * 問い合わせ受付アドレスに加え、実行ユーザーとGmail送信元エイリアスを含める。
 */
function loadInternalMailAddresses_(groupAddress) {
  const addresses = new Set();

  function add(value) {
    const email = extractEmailAddress_(value) || normalizeEmail_(value);
    if (email && email.indexOf('@') >= 0) addresses.add(email);
  }

  add(groupAddress);
  try { add(Session.getEffectiveUser().getEmail()); } catch (ignore) {}
  try { add(Session.getActiveUser().getEmail()); } catch (ignore) {}
  try {
    (GmailApp.getAliases() || []).forEach(function(alias) { add(alias); });
  } catch (ignore) {}

  return addresses;
}

/**
 * メール方向を判定する。
 * Fromが自社アドレスならOUTBOUND、自社アドレスがTo/Ccに含まれればINBOUNDとする。
 * どちらにも該当しないスレッド内メールは誤取込防止のため対象外とする。
 */
function classifyInquiryMessageDirection_(message, internalAddresses) {
  const fromEmail = extractEmailAddress_(message.getFrom());
  if (fromEmail && internalAddresses.has(fromEmail)) return 'OUTBOUND';

  const recipients = extractEmailAddresses_([message.getTo(), message.getCc()].join(','));
  if (recipients.some(function(email) { return internalAddresses.has(email); })) return 'INBOUND';

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
