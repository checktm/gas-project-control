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
  const inquiries = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries));

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

  messages.sort(function(a, b) {
    return String(a.sentAt).localeCompare(String(b.sentAt));
  });
  return messages;
}

/**
 * 問い合わせの管理項目を更新する。
 * メール本文・Gmail IDなどの受信情報はこのAPIでは変更しない。
 */
function updateInquiry(input) {
  if (!input || !input.inquiryId) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  const inquiries = readSheetObjects_(inquirySheet);
  const inquiry = inquiries.find(function(row) {
    return String(row.inquiry_id || '') === String(input.inquiryId);
  });
  if (!inquiry) throw new Error('Inquiry not found: ' + input.inquiryId);

  const status = String(input.status || 'NEW');
  const priority = String(input.priority || 'MEDIUM');
  if (INQUIRY_STATUS_VALUES.indexOf(status) < 0) throw new Error('Invalid inquiry status.');
  if (INQUIRY_PRIORITY_VALUES.indexOf(priority) < 0) throw new Error('Invalid inquiry priority.');

  const customerId = String(input.customerId || '');
  const contactId = String(input.contactId || '');
  const assignedMemberId = String(input.assignedMemberId || '');
  const category = String(input.category || '').trim();

  validateInquiryReferences_(spreadsheet, customerId, contactId, assignedMemberId);
  validateInquiryCategory_(spreadsheet, category);

  const customerMatchStatus = customerId
    ? ((String(inquiry.customer_id || '') === customerId && String(inquiry.customer_match_status || '') !== 'UNMATCHED')
      ? String(inquiry.customer_match_status || 'MANUAL')
      : 'MANUAL')
    : 'UNMATCHED';

  const headers = inquirySheet.getRange(1, 1, 1, inquirySheet.getLastColumn()).getValues()[0];
  const rowValues = inquirySheet.getRange(inquiry._rowIndex, 1, 1, inquirySheet.getLastColumn()).getValues()[0];
  const updates = {
    customer_id: customerId,
    contact_id: contactId,
    status: status,
    priority: priority,
    assigned_member_id: assignedMemberId,
    category: category,
    summary: String(input.summary || ''),
    next_action: String(input.nextAction || ''),
    due_date: parseOptionalDate_(input.dueDate),
    customer_match_status: customerMatchStatus,
    updated_at: new Date()
  };

  headers.forEach(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(updates, header)) rowValues[index] = updates[header];
  });
  inquirySheet.getRange(inquiry._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);

  return getInquiryScreenData();
}

function validateInquiryReferences_(spreadsheet, customerId, contactId, memberId) {
  const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts));
  const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));

  if (customerId && !customers.some(function(row) { return String(row.customer_id || '') === customerId; })) {
    throw new Error('Selected customer does not exist.');
  }
  if (contactId) {
    const contact = contacts.find(function(row) { return String(row.contact_id || '') === contactId; });
    if (!contact) throw new Error('Selected contact does not exist.');
    if (customerId && String(contact.customer_id || '') !== customerId) {
      throw new Error('Selected contact does not belong to selected customer.');
    }
  }
  if (memberId && !members.some(function(row) { return String(row.member_id || '') === memberId; })) {
    throw new Error('Selected member does not exist.');
  }
}

function validateInquiryCategory_(spreadsheet, category) {
  if (!category) return;
  const categories = readSheetObjects_(ensureInquiryCategorySheet_(spreadsheet));
  if (!categories.some(function(row) { return String(row.category_name || '').trim() === category; })) {
    throw new Error('選択した問い合わせ分類が存在しません。');
  }
}

function serializeInquiry_(row, customer, contact, member) {
  return {
    id: String(row.inquiry_id || ''),
    customerId: String(row.customer_id || ''),
    customerName: String(customer.customer_name || ''),
    contactId: String(row.contact_id || ''),
    contactName: String(contact.contact_name || ''),
    contactEmail: String(contact.email || ''),
    gmailThreadId: String(row.gmail_thread_id || ''),
    subject: String(row.subject || ''),
    status: String(row.status || 'NEW'),
    priority: String(row.priority || 'MEDIUM'),
    assignedMemberId: String(row.assigned_member_id || ''),
    assignedMemberName: String(member.member_name || ''),
    category: String(row.category || ''),
    summary: String(row.summary || ''),
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

function indexBy_(rows, key) {
  const result = {};
  rows.forEach(function(row) {
    const value = String(row[key] || '');
    if (value) result[value] = row;
  });
  return result;
}

function parseOptionalDate_(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split('-');
  if (parts.length !== 3) throw new Error('Invalid date.');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatDateForClient_(value, pattern) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}
