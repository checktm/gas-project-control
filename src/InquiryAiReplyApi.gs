/**
 * 問い合わせの管理情報とメール履歴から、顧客へ送る返信文案を生成する。
 * 文案は画面へ返すだけで、自動保存・自動送信しない。
 */
function generateInquiryReplyCandidate(input) {
  input = input || {};
  const inquiryId = String(input.inquiryId || '').trim();
  if (!inquiryId) throw new Error('inquiryId is required.');

  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  ensureInquirySummaryDetailSchema_(spreadsheet);
  const settings = readAiSettings_(spreadsheet);
  if (!settings.enabled) throw new Error('AI機能は無効です。');

  const inquiry = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.inquiries)).find(function(row) {
    return String(row.inquiry_id || '') === inquiryId;
  });
  if (!inquiry) throw new Error('問い合わせが見つかりません。');

  const messages = readSheetObjects_(requireSheet_(spreadsheet, INQUIRY_SHEETS.messages))
    .filter(function(row) { return String(row.inquiry_id || '') === inquiryId; })
    .sort(function(a, b) { return toAiTime_(a.sent_at) - toAiTime_(b.sent_at); });
  if (!messages.length) throw new Error('返信案を作成するメール履歴がありません。');

  // 旧UIとの互換性上、input.summaryには現在の「詳細」入力値が渡る場合がある。
  const detail = String(input.detail || input.summary || inquiry.detail || '');
  const management = [
    '顧客: ' + String(input.customerName || ''),
    '顧客担当者: ' + String(input.contactName || ''),
    '状態: ' + String(input.status || inquiry.status || ''),
    '優先度: ' + String(input.priority || inquiry.priority || ''),
    '自社担当: ' + String(input.assigneeName || ''),
    '分類: ' + String(input.category || inquiry.category || ''),
    '対応期限: ' + String(input.dueDate || inquiry.due_date || ''),
    '概要: ' + String(inquiry.summary || inquiry.subject || ''),
    '詳細: ' + detail,
    '次回対応: ' + String(input.nextAction || inquiry.next_action || '')
  ].join('\n');

  const history = buildAiHistory_(messages, settings.maxInputChars);
  const prompt = [
    'あなたは業務問い合わせへの返信文案を作るアシスタントです。',
    '以下の管理情報とメール履歴を踏まえ、担当者がそのまま確認・修正して送れる日本語の返信本文案を作成してください。',
    '要件:',
    '- 最新の顧客側メールへの返信として自然な内容にする',
    '- 管理情報の「概要」「詳細」「次回対応」「対応期限」を特に参考にする',
    '- 内部管理用の状態名、優先度、分類、自社担当などを顧客向け本文へ不用意に書かない',
    '- メールや管理情報にない事実を推測しない',
    '- 判断できない事項は断定せず、必要なら確認する表現にする',
    '- 丁寧で簡潔な業務メールにする',
    '- 件名、コードブロック、解説は付けず、返信本文だけを返す',
    '',
    'メール件名: ' + String(inquiry.subject || ''),
    '',
    '管理情報:',
    management,
    '',
    'メール履歴:',
    history
  ].join('\n');

  const generated = generateGeminiTextWithMeta_(prompt, settings.model, settings.fallbackModel);
  return {
    reply: generated.text,
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
    model: generated.model,
    fallbackUsed: generated.fallbackUsed
  };
}
