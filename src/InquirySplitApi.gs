/**
 * 同一Gmailスレッド内で別件が始まった場合、指定した受信メール以降を新しいInquiryへ分離する。
 * Gmailスレッドは同じまま、業務上の問い合わせ単位だけを分ける。
 */
function splitInquiryFromMessage(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const messageId = String(input.messageId || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!messageId) throw new Error('messageId is required.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
    const messageSheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
    const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    });
    if (!inquiry) throw new Error('分離元の問い合わせが見つかりません。');

    const messages = readSheetObjects_(messageSheet).filter(function(row) {
      return String(row.inquiry_id || '') === inquiryId;
    }).sort(function(a, b) {
      const diff = toInquirySplitTime_(a.sent_at) - toInquirySplitTime_(b.sent_at);
      return diff || Number(a._rowIndex || 0) - Number(b._rowIndex || 0);
    });

    const boundaryIndex = messages.findIndex(function(row) {
      return String(row.message_id || '') === messageId;
    });
    if (boundaryIndex < 0) throw new Error('分離開始メールが見つかりません。');

    const boundary = messages[boundaryIndex];
    if (String(boundary.direction || 'INBOUND').toUpperCase() !== 'INBOUND') {
      throw new Error('別問い合わせの開始位置には受信メールを選択してください。');
    }
    if (boundaryIndex === 0) {
      throw new Error('最初のメールから分離すると元の問い合わせが空になるため分離できません。');
    }

    const gmailThreadId = String(boundary.gmail_thread_id || inquiry.gmail_thread_id || '');
    if (!gmailThreadId) throw new Error('GmailスレッドIDがないため分離できません。');

    const movedMessages = messages.slice(boundaryIndex);
    const remainingMessages = messages.slice(0, boundaryIndex);
    const matchedCustomer = matchCustomer_(String(boundary.from_email || ''), loadCustomerMatchData_(spreadsheet));

    const newInquiry = createInquiry_(inquirySheet, {
      gmailThreadId: gmailThreadId,
      subject: String(boundary.subject || inquiry.subject || ''),
      matchedCustomer: matchedCustomer,
      receivedAt: boundary.sent_at || new Date()
    });

    movedMessages.forEach(function(row) {
      writeRowUpdates_(messageSheet, row._rowIndex, {
        inquiry_id: newInquiry.inquiry_id
      });
    });

    const sourceLast = remainingMessages[remainingMessages.length - 1];
    const newLast = movedMessages[movedMessages.length - 1];
    writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
      last_message_at: sourceLast ? sourceLast.sent_at : inquiry.received_at,
      updated_at: new Date()
    });
    writeRowUpdates_(inquirySheet, newInquiry._rowIndex, {
      last_message_at: newLast ? newLast.sent_at : boundary.sent_at,
      updated_at: new Date()
    });

    return {
      sourceInquiryId: inquiryId,
      newInquiryId: newInquiry.inquiry_id,
      movedCount: movedMessages.length,
      inquiryData: getInquiryScreenData(),
      sourceMessages: getInquiryMessages(inquiryId),
      newMessages: getInquiryMessages(newInquiry.inquiry_id)
    };
  } finally {
    lock.releaseLock();
  }
}

function toInquirySplitTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}
