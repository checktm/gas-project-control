/**
 * Inquiriesの「概要」と「詳細」の役割を分離し、問い合わせ単位の対象外フラグを保証する。
 *
 * - summary = 一覧・見出し用の短い概要（初期値はメール件名）
 * - detail  = 旧summary相当の詳細説明
 * - excluded = 問い合わせ一覧・集計から除外する問い合わせ単位フラグ
 *
 * 既存シートにdetail列がない場合だけ、旧summaryをdetailへ退避し、
 * summaryをメール件名で初期化する。excluded列がない場合は追加し、既存行はFALSEとする。
 */
function ensureInquirySummaryDetailSchema_(spreadsheet) {
  const sheet = requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries);
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Inquiriesのヘッダーがありません。');

  let headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  const subjectIndex = headers.indexOf('subject');
  const summaryIndex = headers.indexOf('summary');
  if (subjectIndex < 0 || summaryIndex < 0) {
    throw new Error('Inquiries に subject / summary 列がありません。');
  }

  let detailIndex = headers.indexOf('detail');
  const rowCount = Math.max(0, sheet.getLastRow() - 1);

  if (detailIndex < 0) {
    sheet.insertColumnAfter(lastColumn);
    lastColumn += 1;
    detailIndex = lastColumn - 1;
    sheet.getRange(1, lastColumn).setValue('detail');

    if (rowCount > 0) {
      const oldSummaries = sheet.getRange(2, summaryIndex + 1, rowCount, 1).getValues();
      const subjects = sheet.getRange(2, subjectIndex + 1, rowCount, 1).getValues();
      sheet.getRange(2, detailIndex + 1, rowCount, 1).setValues(oldSummaries);
      sheet.getRange(2, summaryIndex + 1, rowCount, 1).setValues(subjects.map(function(row) {
        return [String(row[0] || '')];
      }));
    }
  } else if (rowCount > 0) {
    const summaries = sheet.getRange(2, summaryIndex + 1, rowCount, 1).getValues();
    const subjects = sheet.getRange(2, subjectIndex + 1, rowCount, 1).getValues();
    let changed = false;
    summaries.forEach(function(row, index) {
      if (!String(row[0] || '').trim() && String(subjects[index][0] || '').trim()) {
        row[0] = String(subjects[index][0] || '');
        changed = true;
      }
    });
    if (changed) sheet.getRange(2, summaryIndex + 1, rowCount, 1).setValues(summaries);
  }

  headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });
  if (headers.indexOf('excluded') < 0) {
    sheet.insertColumnAfter(sheet.getLastColumn());
    const excludedColumn = sheet.getLastColumn();
    sheet.getRange(1, excludedColumn).setValue('excluded');
    if (rowCount > 0) {
      sheet.getRange(2, excludedColumn, rowCount, 1).setValues(Array(rowCount).fill(null).map(function() { return [false]; }));
    }
  }

  return sheet;
}
