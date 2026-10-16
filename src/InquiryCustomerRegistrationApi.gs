/**
 * 問い合わせの受信メール送信元ドメインを、新しい顧客として登録する。
 * 問い合わせが顧客未設定の場合だけ、作成した顧客をその問い合わせへ紐付ける。
 */
function registerCustomerFromInquiryMessage(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const messageId = String(input.messageId || '').trim();
  const customerName = String(input.customerName || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!messageId) throw new Error('messageId is required.');
  if (!customerName) throw new Error('顧客名を入力してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquirySheet = ensureInquirySummaryDetailSchema_(spreadsheet);
    const messageSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
    const customerSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.customers);

    const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('問い合わせが見つかりません。');

    const message = readSheetObjects_(messageSheet).find(function(row) {
      return String(row.message_id || '') === messageId && String(row.inquiry_id || '') === inquiryId;
    });
    if (!message) throw new Error('対象メールが見つかりません。');
    if (String(message.direction || 'INBOUND').toUpperCase() !== 'INBOUND') {
      throw new Error('顧客登録は受信メールから行ってください。');
    }

    const sender = normalizeEmail_(message.from_email);
    const at = sender.lastIndexOf('@');
    if (at < 1 || at >= sender.length - 1) throw new Error('送信元メールアドレスからドメインを取得できません。');
    const domain = normalizeDomain_(sender.slice(at + 1));
    if (!domain) throw new Error('送信元ドメインを取得できません。');

    const existing = readSheetObjects_(customerSheet).find(function(row) {
      return normalizeDomain_(row.domain) === domain;
    });
    if (existing) {
      throw new Error('このドメインは既に顧客「' + String(existing.customer_name || existing.customer_id || '') + '」へ登録されています。');
    }

    const customerId = saveMasterRow_(customerSheet, 'customer_id', '', 'CUS', {
      customer_name: customerName,
      domain: domain,
      status: 'ACTIVE',
      note: '問い合わせメールから登録',
      updated_at: new Date()
    });

    const linkedToInquiry = !String(inquiry.customer_id || '').trim();
    if (linkedToInquiry) {
      writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
        customer_id: customerId,
        contact_id: '',
        customer_match_status: 'MANUAL',
        updated_at: new Date()
      });
    }

    return {
      customerId: customerId,
      customerName: customerName,
      domain: domain,
      linkedToInquiry: linkedToInquiry,
      inquiryData: getInquiryScreenData()
    };
  } finally {
    lock.releaseLock();
  }
}
