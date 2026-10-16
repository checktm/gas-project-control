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
