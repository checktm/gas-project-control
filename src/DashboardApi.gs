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