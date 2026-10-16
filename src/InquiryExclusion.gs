/**
 * 問い合わせ一覧の対象外ドメイン設定を読み込む。
 * 登録したドメインと完全一致する送信元だけを対象外とする。
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
    return domain === normalizeMatchDomain_(excluded);
  });
}

/**
 * 問い合わせの開始元となった最初の受信メール送信元を取得する。
 * 一覧対象外判定は、後続メールで表示可否が揺れないよう開始元で固定する。
 */
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
 * Settings の対象外ドメインに完全一致する問い合わせを一覧・集計から除外する。
 * データ自体は削除しないため、設定から外せば再表示できる。
 */
function filterInquiryRowsByExcludedDomains_(spreadsheet, inquiries) {
  const rows = inquiries || [];
  const excludedDomains = loadInquiryExcludedDomains_(spreadsheet);
  if (!excludedDomains.length || !rows.length) return rows;

  const ids = new Set(rows.map(function(row) {
    return String(row.inquiry_id || '');
  }).filter(Boolean));
  const firstSenderByInquiry = loadFirstInboundSenderByInquiry_(spreadsheet, ids);

  return rows.filter(function(row) {
    const sender = firstSenderByInquiry[String(row.inquiry_id || '')] || '';
    return !sender || !isInquiryExcludedDomain_(sender, excludedDomains);
  });
}
