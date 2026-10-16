/**
 * 外部ドメイン設定を読み込む。
 * この設定は今後新しく作成される問い合わせの初期対象外判定に利用する。
 */
function loadInquiryExcludedDomains_(spreadsheet) {
  const settings = loadSettings_(spreadsheet);
  return parseSettingList_(settings.INQUIRY_EXCLUDED_DOMAINS).map(function(value) {
    return normalizeMatchDomain_(value);
  }).filter(function(domain, index, values) {
    return !!domain && values.indexOf(domain) === index;
  });
}

function isInquiryExcludedDomain_(emailOrDomain, excludedDomains) {
  const text = String(emailOrDomain || '').trim().toLowerCase();
  const domain = normalizeMatchDomain_(text.indexOf('@') >= 0 ? text.split('@').slice(-1)[0] : text);
  if (!domain) return false;
  return (excludedDomains || []).some(function(excluded) {
    return domain === excluded || domain.endsWith('.' + excluded);
  });
}

/** 問い合わせの開始元となった最初の受信メール送信元を取得する。 */
function loadFirstInboundSenderByInquiry_(spreadsheet, inquiryIds) {
  const targetIds = inquiryIds instanceof Set ? inquiryIds : new Set((inquiryIds || []).map(String));
  if (!targetIds.size) return {};

  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.messages);
  const rows = readSheetObjects_(sheet);
  const result = {};

  rows.forEach(function(row) {
    const inquiryId = String(row.inquiry_id || '');
    if (!targetIds.has(inquiryId)) return;
    if (String(row.direction || 'INBOUND').toUpperCase() !== 'INBOUND') return;
    const fromEmail = extractEmailAddress_(row.from_email) || normalizeEmail_(row.from_email);
    if (!fromEmail) return;
    const time = toInquiryTime_(row.sent_at);
    if (!result[inquiryId] || time < result[inquiryId].time) {
      result[inquiryId] = { email: fromEmail, time: time };
    }
  });

  const senderByInquiry = {};
  Object.keys(result).forEach(function(inquiryId) {
    senderByInquiry[inquiryId] = result[inquiryId].email;
  });
  return senderByInquiry;
}

/**
 * 一覧・集計から除外するのは excluded がTRUEの問い合わせだけとする。
 * ドメイン設定を変更しても既存問い合わせへ遡って一括適用しない。
 */
function filterInquiryRowsByExcludedDomains_(spreadsheet, inquiries) {
  return (inquiries || []).filter(function(row) {
    return !isTrue_(row.excluded);
  });
}
