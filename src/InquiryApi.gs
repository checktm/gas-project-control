const INQUIRY_STATUS_VALUES = ['NEW', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
const INQUIRY_PRIORITY_VALUES = ['HIGH', 'MEDIUM', 'LOW'];

/**
 * 問い合わせ管理画面の初期表示データを返す。
 */
function getInquiryScreenData() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const customers = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.customers));
  const contacts = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.contacts));
  const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
  const inquiries = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries));
  const messages = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages));

  const customerById = indexBy_(customers, 'customer_id');
  const contactById = indexBy_(contacts, 'contact_id');
  const memberById = indexBy_(members, 'member_id');
  const messagesByInquiry = {};

  messages.forEach(function(row) {
    const inquiryId = String(row.inquiry_id || '');
    if (!inquiryId) return;
    if (!messagesByInquiry[inquiryId]) messagesByInquiry[inquiryId] = [];
    messagesByInquiry[inquiryId].push(serializeInquiryMessage_(row));
  });

  Object.keys(messagesByInquiry).forEach(function(inquiryId) {
    messagesByInquiry[inquiryId].sort(function(a, b) {
      return String(a.sentAt).localeCompare(String(b.sentAt));
    });
  });

  return {
    inquiries: inquiries.map(function(row) {
      const customer = customerById[String(row.customer_id || '')] || {};
      const contact = contactById[String(row.contact_id || '')] || {};
      const member = memberById[String(row.assigned_member_id || '')] || {};
      return serializeInquiry_(row, customer, contact, member, messagesByInquiry[String(row.inquiry_id || '')] || []);
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
    statusValues: INQUIRY_STATUS_VALUES,
    priorityValues: INQUIRY_PRIORITY_VALUES
  };
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

  validateInquiryReferences_(spreadsheet, customerId, contactId, assignedMemberId);

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
    category: String(input.category || ''),
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

function serializeInquiry_(row, customer, contact, member, messages) {
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
    updatedAt: formatDateForClient_(row.updated_at, "yyyy-MM-dd'T'HH:mm:ss"),
    messages: messages
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
