/**
 * Workspaceユーザー照合。認可の正本はUsersシートとし、クライアント入力を信用しない。
 * アプリ全体の強制適用は全公開APIのガード追加・開発環境の本人識別試験後に有効化する。
 */
const USER_ACCESS_ROLES_ = ['ADMIN', 'USER'];

function normalizeAccessEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

/** 同一Workspaceドメイン構成での本人識別を検証する診断API（業務データは返さない）。 */
function checkWorkspaceIdentity() {
  const email = normalizeAccessEmail_(Session.getActiveUser().getEmail());
  return {
    emailAvailable: !!email,
    email: email,
    matched: !!(email && findAccessUser_(email)),
    role: email ? ((findAccessUser_(email) || {}).role || '') : ''
  };
}

function ensureUsersSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName('Users');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Users');
    sheet.getRange(1, 1, 1, 7).setValues([[
      'user_id', 'user_name', 'email', 'role', 'active', 'member_id', 'updated_at'
    ]]);
    sheet.setFrozenRows(1);
  }
  validateCustomerSheetHeaders_(sheet, [
    'user_id', 'user_name', 'email', 'role', 'active', 'member_id', 'updated_at'
  ]);
  return sheet;
}

/** Usersシートへの初回管理者登録は導入手順に従い管理者が直接行う。 */
function findAccessUser_(email) {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = spreadsheet.getSheetByName('Users');
  if (!sheet) return null;
  const normalized = normalizeAccessEmail_(email);
  if (!normalized) return null;
  const matches = readSheetObjects_(sheet).filter(function(row) {
    return normalizeAccessEmail_(row.email) === normalized;
  });
  if (matches.length !== 1) return null;
  const row = matches[0];
  const role = String(row.role || '').trim().toUpperCase();
  if (USER_ACCESS_ROLES_.indexOf(role) < 0 || !isTrue_(row.active)) return null;
  return { id: String(row.user_id || ''), name: String(row.user_name || ''), email: normalized, role: role };
}

/** 今後すべてのWeb業務APIの冒頭で呼ぶ（漏れがあればアクセス制限不完全）。 */
function requireAccessUser_(requiredRole) {
  const email = normalizeAccessEmail_(Session.getActiveUser().getEmail());
  if (!email) throw new Error('Google Workspaceのログインユーザーを確認できません。管理者へお問い合わせください。');
  const user = findAccessUser_(email);
  if (!user) throw new Error('このアカウントには利用権限がありません。管理者へお問い合わせください。');
  if (requiredRole === 'ADMIN' && user.role !== 'ADMIN') {
    throw new Error('この操作は管理者のみ実行できます。');
  }
  return user;
}

/** 管理者専用UsersマスタAPI。認証強制適用前でも管理者以外は呼び出せない。 */
function getUsersMasterData() {
  requireAccessUser_('ADMIN');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  return readSheetObjects_(ensureUsersSheet_(spreadsheet)).map(function(row) {
    return {
      id: String(row.user_id || ''),
      name: String(row.user_name || ''),
      email: normalizeAccessEmail_(row.email),
      role: String(row.role || ''),
      active: isTrue_(row.active),
      memberId: String(row.member_id || '')
    };
  });
}

function saveAccessUser(input) {
  requireAccessUser_('ADMIN');
  input = input || {};
  const email = normalizeAccessEmail_(input.email);
  const name = String(input.name || '').trim();
  const role = String(input.role || '').trim().toUpperCase();
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('氏名と正しいメールアドレスが必要です。');
  if (USER_ACCESS_ROLES_.indexOf(role) < 0) throw new Error('権限が不正です。');
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const sheet = ensureUsersSheet_(spreadsheet);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('更新が競合しています。');
  try {
    const rows = readSheetObjects_(sheet);
    const id = String(input.id || '').trim();
    const duplicate = rows.find(function(row) {
      return normalizeAccessEmail_(row.email) === email && String(row.user_id || '') !== id;
    });
    if (duplicate) throw new Error('同じメールアドレスが既に登録されています。');
    const existing = id ? rows.find(function(row) { return String(row.user_id || '') === id; }) : null;
    if (id && !existing) throw new Error('更新対象が見つかりません。');
    const active = input.active !== false;
    // 最後の有効な管理者を無効化/降格しない。
    const remainingAdmins = rows.filter(function(row) {
      if (existing && String(row.user_id || '') === id) return active && role === 'ADMIN';
      return isTrue_(row.active) && String(row.role || '').toUpperCase() === 'ADMIN';
    });
    if (remainingAdmins.length < 1) throw new Error('有効な管理者を最低1名残してください。');
    const memberId = String(input.memberId || '').trim();
    if (memberId && !readSheetObjects_(requireSheet_(spreadsheet, 'Members')).some(function(row) {
      return String(row.member_id || '') === memberId;
    })) throw new Error('社内メンバーが存在しません。');
    const userId = saveMasterRow_(sheet, 'user_id', id, 'USR', {
      user_name: name, email: email, role: role, active: active,
      member_id: memberId, updated_at: new Date()
    });
    return { id: userId, users: getUsersMasterData() };
  } finally {
    lock.releaseLock();
  }
}


/**
 * 既存MembersからUsersへ登録する候補を返す。顧客担当者は対象に含めない。
 * 既存Usersは上書きせず、未登録の有効メンバーだけを候補にする。
 */
function previewMembersForUserImport() {
  const admin = requireAccessUser_('ADMIN');
  const adminDomain = admin.email.split('@')[1];
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
  const existing = readSheetObjects_(ensureUsersSheet_(spreadsheet));
  const used = {};
  existing.forEach(function(row) { used[normalizeAccessEmail_(row.email)] = true; });
  const candidates = [];
  const skipped = [];
  const seen = {};
  readSheetObjects_(requireSheet_(spreadsheet, 'Members')).forEach(function(row) {
    const id = String(row.member_id || '').trim();
    const email = normalizeAccessEmail_(row.email);
    const name = String(row.member_name || '').trim();
    if (!isTrue_(row.active) || !id || !name || !email || email.split('@')[1] !== adminDomain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped.push({memberId:id,reason:'無効・メール未設定・ドメイン不一致など'});
      return;
    }
    if (used[email] || seen[email]) {
      skipped.push({memberId:id,reason:'ユーザー登録済み、またはメール重複'});
      return;
    }
    seen[email] = true;
    candidates.push({memberId:id,name:name,email:email});
  });
  return {candidates:candidates,skipped:skipped};
}

/** 管理者が画面で確認して選択した社内メンバーのみ、一般ユーザーとして追加。 */
function importMembersAsUsers(input) {
  const admin = requireAccessUser_('ADMIN');
  const adminDomain = admin.email.split('@')[1];
  const ids = Array.isArray(input && input.memberIds) ? input.memberIds.map(String) : [];
  const selected = {};
  ids.forEach(function(id) { if (id) selected[id] = true; });
  if (!Object.keys(selected).length) throw new Error('登録する社内メンバーを選択してください。');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('登録処理が競合しました。');
  try {
    const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.spreadsheetId);
    const usersSheet = ensureUsersSheet_(spreadsheet);
    const users = readSheetObjects_(usersSheet);
    const existingEmails = {};
    users.forEach(function(row) { existingEmails[normalizeAccessEmail_(row.email)] = true; });
    const members = readSheetObjects_(requireSheet_(spreadsheet, 'Members'));
    const matches = members.filter(function(row) { return selected[String(row.member_id || '')]; });
    if (matches.length !== Object.keys(selected).length) throw new Error('選択されたメンバーが見つかりません。再読み込みしてください。');
    const newUsers = [];
    const seen = {};
    matches.forEach(function(row) {
      const email = normalizeAccessEmail_(row.email);
      const name = String(row.member_name || '').trim();
      const memberId = String(row.member_id || '');
      if (!isTrue_(row.active) || !name || !email || email.split('@')[1] !== adminDomain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('取込不可のメンバーが選択されています: '+memberId);
      if (existingEmails[email] || seen[email]) throw new Error('ユーザー登録済みまたはメール重複: '+email);
      seen[email] = true;
      newUsers.push([createStableId_('USR'),name,email,'USER',true,memberId,new Date()]);
    });
    const headers = usersSheet.getRange(1,1,1,usersSheet.getLastColumn()).getValues()[0];
    const fields = ['user_id','user_name','email','role','active','member_id','updated_at'];
    newUsers.forEach(function(values) {
      const data = {};
      fields.forEach(function(field,i) { data[field] = values[i]; });
      usersSheet.appendRow(headers.map(function(header) { return Object.prototype.hasOwnProperty.call(data,header)?data[header]:''; }));
    });
    return {created:newUsers.length,users:readSheetObjects_(usersSheet).map(function(row) {
      return {id:String(row.user_id||''),name:String(row.user_name||''),email:normalizeAccessEmail_(row.email),role:String(row.role||''),active:isTrue_(row.active),memberId:String(row.member_id||'')};
    })};
  } finally { lock.releaseLock(); }
}
