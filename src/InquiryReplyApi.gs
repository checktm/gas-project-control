/**
 * 問い合わせの最新受信メールへ返信する。
 * Gmail上の同一スレッドを維持し、送信後はInquiryMessagesへOUTBOUNDとして記録する。
 */
function sendInquiryReply(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  const body = String(input.body || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');
  if (!body) throw new Error('返信本文を入力してください。');
  if (body.length > 20000) throw new Error('返信本文が長すぎます。20,000文字以内にしてください。');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const inquirySheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  const inquiry = readSheetObjects_(inquirySheet).find(function(row) {
    return String(row.inquiry_id || '') === inquiryId;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const target = findLatestInboundReplyTarget_(spreadsheet, inquiryId);
  if (!target || !target.gmailMessageId) {
    throw new Error('返信元となる受信メールが見つかりません。');
  }

  const sourceMessage = GmailApp.getMessageById(target.gmailMessageId);
  if (!sourceMessage) throw new Error('Gmail上の返信元メールが見つかりません。');

  const thread = sourceMessage.getThread();
  const beforeIds = {};
  thread.getMessages().forEach(function(message) {
    beforeIds[message.getId()] = true;
  });

  // GmailMessage.reply() を使うことで、元メールのReply-Toを尊重して同一スレッドへ返信する。
  sourceMessage.reply(body);

  const sentMessage = findNewThreadMessageAfterReply_(thread, beforeIds);
  appendOutboundReply_(spreadsheet, inquiry, target, body, sentMessage);

  // 一覧の最終メール日時も送信時刻へ更新する。
  const sentAt = sentMessage ? sentMessage.getDate() : new Date();
  writeRowUpdates_(inquirySheet, inquiry._rowIndex, {
    last_message_at: sentAt,
    updated_at: new Date()
  });

  return {
    recipient: target.replyTo || target.fromEmail,
    sentAt: formatDateForClient_(sentAt, "yyyy-MM-dd'T'HH:mm:ss"),
    messages: getInquiryMessages(inquiryId),
    inquiryData: getInquiryScreenData()
  };
}

/** 最新の受信メールを返信対象として返す。 */
function findLatestInboundReplyTarget_(spreadsheet, inquiryId) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const rows = readSheetObjects_(sheet).filter(function(row) {
    return String(row.inquiry_id || '') === inquiryId &&
      String(row.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
      String(row.gmail_message_id || '').trim();
  });
  if (!rows.length) return null;
  rows.sort(function(a, b) {
    return toReplyTime_(b.sent_at) - toReplyTime_(a.sent_at);
  });
  const row = rows[0];
  let replyTo = '';
  try {
    const gmailMessage = GmailApp.getMessageById(String(row.gmail_message_id || ''));
    replyTo = gmailMessage ? String(gmailMessage.getReplyTo() || '').trim() : '';
  } catch (ignore) {}
  return {
    gmailMessageId: String(row.gmail_message_id || ''),
    fromEmail: String(row.from_email || ''),
    replyTo: replyTo
  };
}

/** 返信後にスレッドへ追加されたメールを特定する。 */
function findNewThreadMessageAfterReply_(thread, beforeIds) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) Utilities.sleep(400 * attempt);
    thread.refresh();
    const newMessages = thread.getMessages().filter(function(message) {
      return !beforeIds[message.getId()];
    });
    if (newMessages.length) {
      newMessages.sort(function(a, b) { return b.getDate().getTime() - a.getDate().getTime(); });
      return newMessages[0];
    }
  }
  // メール送信自体は成功しているため、履歴特定失敗を送信失敗として扱わない。
  return null;
}

function appendOutboundReply_(spreadsheet, inquiry, target, body, sentMessage) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const sentAt = sentMessage ? sentMessage.getDate() : new Date();
  const gmailMessageId = sentMessage ? sentMessage.getId() : '';
  const gmailThreadId = sentMessage
    ? sentMessage.getThread().getId()
    : String(inquiry.gmail_thread_id || '');
  const fromEmail = sentMessage
    ? extractEmailAddress_(sentMessage.getFrom())
    : String(Session.getEffectiveUser().getEmail() || '');
  const toEmail = sentMessage
    ? sentMessage.getTo()
    : (target.replyTo || target.fromEmail);
  const subject = sentMessage
    ? sentMessage.getSubject()
    : String(inquiry.subject || '');

  sheet.appendRow([
    createStableId_('MSG'),
    String(inquiry.inquiry_id || ''),
    gmailMessageId,
    gmailThreadId,
    'OUTBOUND',
    fromEmail,
    toEmail,
    subject,
    body,
    sentAt,
    new Date()
  ]);
}

function toReplyTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}
