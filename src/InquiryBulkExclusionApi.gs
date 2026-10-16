/**
 * 問い合わせ一覧で選択した未特定問い合わせの送信元ドメインを、まとめて対象外登録する。
 * データ自体は削除せず、INQUIRY_EXCLUDED_DOMAINS へ追加する。
 */
function excludeInquiryDomainsBulk(input) {
  input = input || {};
  const inquiryIds = Array.isArray(input.inquiryIds) ? input.inquiryIds.map(function(value) {
    return String(value || '').trim();
  }).filter(Boolean) : [];

  const uniqueIds = inquiryIds.filter(function(id, index, values) {
    return values.indexOf(id) === index;
  });
  if (!uniqueIds.length) throw new Error('対象の問い合わせを選択してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('別の更新処理が実行中です。少し待ってから再度お試しください。');

  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const inquiryRows = readSheetObjects_(ensureInquirySummaryDetailSchema_(spreadsheet));
    const inquiryById = {};
    inquiryRows.forEach(function(row) {
      inquiryById[String(row.inquiry_id || '')] = row;
    });

    const firstSenderByInquiry = loadFirstInboundSenderByInquiry_(spreadsheet, new Set(uniqueIds));
    const domains = [];
    const excludedInquiryIds = [];
    const skipped = [];

    uniqueIds.forEach(function(inquiryId) {
      const inquiry = inquiryById[inquiryId];
      if (!inquiry) {
        skipped.push({ inquiryId: inquiryId, reason: '問い合わせが見つかりません。' });
        return;
      }
      if (String(inquiry.customer_id || '').trim()) {
        skipped.push({ inquiryId: inquiryId, reason: '顧客特定済みのため対象外登録しませんでした。' });
        return;
      }

      const sender = firstSenderByInquiry[inquiryId] || '';
      const at = String(sender).lastIndexOf('@');
      const domain = at > 0 && at < String(sender).length - 1
        ? normalizeDomain_(String(sender).slice(at + 1))
        : '';
      if (!domain) {
        skipped.push({ inquiryId: inquiryId, reason: '送信元ドメインを取得できませんでした。' });
        return;
      }

      if (domains.indexOf(domain) < 0) domains.push(domain);
      excludedInquiryIds.push(inquiryId);
    });

    if (!domains.length) throw new Error('対象外登録できる送信元ドメインがありません。');

    const settingsSheet = requireSheet_(spreadsheet, 'Settings');
    const settingsRows = readSheetObjects_(settingsSheet);
    let settingRow = settingsRows.find(function(row) {
      return String(row.setting_key || '') === 'INQUIRY_EXCLUDED_DOMAINS';
    });
    const current = settingRow ? String(settingRow.setting_value || '') : '';
    const mergedValue = normalizeDomainListSetting_([current].concat(domains).filter(Boolean).join(', '));

    if (settingRow) {
      writeRowUpdates_(settingsSheet, settingRow._rowIndex, {
        setting_value: mergedValue,
        updated_at: new Date()
      });
    } else {
      settingsSheet.appendRow([
        'INQUIRY_EXCLUDED_DOMAINS',
        mergedValue,
        '問い合わせ一覧・集計から除外する送信元ドメイン。',
        new Date()
      ]);
    }

    return {
      domains: domains,
      excludedInquiryIds: excludedInquiryIds,
      skipped: skipped,
      inquiryData: getInquiryScreenData()
    };
  } finally {
    lock.releaseLock();
  }
}
