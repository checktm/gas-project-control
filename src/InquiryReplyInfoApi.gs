/** 返信画面で送信前に実際の返信先を確認するための情報を返す。 */
function getInquiryReplyInfo(inquiryId) {
  const id = String(inquiryId || '').trim();
  if (!id) throw new Error('inquiryId is required.');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const target = findLatestInboundReplyTarget_(spreadsheet, id);
  if (!target) return null;

  const rows = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages)).filter(function(row) {
    return String(row.inquiry_id || '') === id && String(row.gmail_message_id || '') === target.gmailMessageId;
  });
  const row = rows.length ? rows[0] : {};
  return {
    recipient: target.replyTo || target.fromEmail,
    fromEmail: target.fromEmail,
    subject: String(row.subject || ''),
    sentAt: formatDateForClient_(row.sent_at, "yyyy-MM-dd'T'HH:mm:ss")
  };
}
