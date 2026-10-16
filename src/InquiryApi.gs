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
  const inquiries = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet));

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
