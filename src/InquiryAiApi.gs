/** 問い合わせメール履歴からAI要約候補を生成する。保存はしない。 */
function generateInquirySummary(inquiryId) {
  const id = String(inquiryId || '').trim();
  if (!id) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const settings = readAiSettings_(spreadsheet);
  if (!settings.enabled) throw new Error('AI要約機能は無効です。システム設定で有効にしてください。');

  const inquiry = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries)).find(function(row) {
    return String(row.inquiry_id || '') === id;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const messages = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages))
    .filter(function(row) { return String(row.inquiry_id || '') === id; })
    .sort(function(a, b) { return toAiTime_(a.sent_at) - toAiTime_(b.sent_at); });
  if (!messages.length) throw new Error('要約対象のメール履歴がありません。');

  const history = buildAiHistory_(messages, settings.maxInputChars);
  const prompt = [
    'あなたは業務問い合わせを整理するアシスタントです。',
    '以下のメール履歴を、担当者が短時間で状況把握できる日本語の概要にしてください。',
    '要件:',
    '- 3〜6行程度で簡潔にまとめる',
    '- 問い合わせの主旨と顧客が求めていることを優先する',
    '- 期限・希望日・重要条件があれば含める',
    '- メールにない内容を推測しない',
    '- 挨拶、署名、定型文は原則省略する',
    '- そのまま概要欄へ貼れる文章だけを返す',
    '',
    '問い合わせ件名: ' + String(inquiry.subject || ''),
    '',
    'メール履歴:',
    history
  ].join('\n');

  return {
    summary: generateGeminiText_(prompt, settings.model),
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
    model: settings.model
  };
}

function readAiSettings_(spreadsheet) {
  const values = {};
  readSheetObjects_(requireSheet_(spreadsheet, 'Settings')).forEach(function(row) {
    const key = String(row.setting_key || '').trim();
    if (key) values[key] = String(row.setting_value == null ? '' : row.setting_value).trim();
  });
  const n = Number(values.GEMINI_MAX_INPUT_CHARS || '30000');
  return {
    enabled: String(values.GEMINI_AI_ENABLED || 'FALSE').toUpperCase() === 'TRUE',
    model: values.GEMINI_MODEL || 'gemini-3.8-flash',
    maxInputChars: Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 30000
  };
}

function buildAiHistory_(messages, maxChars) {
  const blocks = messages.map(function(row) {
    return [
      '方向: ' + String(row.direction || 'INBOUND'),
      '日時: ' + formatDateForClient_(row.sent_at, 'yyyy-MM-dd HH:mm:ss'),
      '送信元: ' + String(row.from_email || ''),
      '件名: ' + String(row.subject || ''),
      '本文:',
      cleanAiMailBody_(row.body)
    ].join('\n');
  });
  const selected = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (selected.length && total + block.length + 8 > maxChars) break;
    if (!selected.length && block.length > maxChars) {
      selected.unshift(block.slice(block.length - maxChars));
      break;
    }
    selected.unshift(block);
    total += block.length + 8;
  }
  return selected.join('\n\n---\n\n');
}

function cleanAiMailBody_(value) {
  let text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const patterns = [/^On .+ wrote:$/m, /^-{2,}\s*Original Message\s*-{2,}$/mi, /^-{2,}\s*元のメッセージ\s*-{2,}$/m];
  let cutAt = text.length;
  patterns.forEach(function(pattern) {
    const match = pattern.exec(text);
    if (match && match.index > 0) cutAt = Math.min(cutAt, match.index);
  });
  return text.slice(0, cutAt).trim();
}

function toAiTime_(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}
