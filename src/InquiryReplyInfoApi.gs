/** 返信画面で送信前に実際の返信先と初期CCを確認するための情報を返す。 */
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
  const recipient = target.replyTo || target.fromEmail;
  return {
    recipient: recipient,
    fromEmail: target.fromEmail,
    cc: buildDefaultInquiryReplyCc_(spreadsheet, target.sourceCc, recipient),
    subject: String(row.subject || ''),
    sentAt: formatDateForClient_(row.sent_at, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

/**
 * 元メールのCCを返信画面の初期値にする。
 * 主宛先との重複と、自社ドメイン・社内メンバー・問い合わせ受付アドレスは除外する。
 */
function buildDefaultInquiryReplyCc_(spreadsheet, sourceCc, recipient) {
  const settings = loadSettings_(spreadsheet);
  const receptionAddresses = getInquiryReceptionAddresses_(settings);
  const internalIdentity = loadInternalMailIdentity_(spreadsheet, settings, receptionAddresses);
  const mainRecipient = extractEmailAddress_(recipient) || normalizeEmail_(recipient);
  const seen = {};
  const result = [];

  extractEmailAddresses_(sourceCc).forEach(function(email) {
    if (!email || email === mainRecipient || seen[email]) return;
    if (isInternalEmail_(email, internalIdentity)) return;
    seen[email] = true;
    result.push(email);
  });
  return result;
}
