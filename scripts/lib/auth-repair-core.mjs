// =====================================================================
//  منطق إصلاح حسابات Auth (خادميّ، قابل للاختبار) — لا يستورد supabase-js.
//  تُحقن دالة العميل (admin) من الخارج، فتُختبَر كل المسارات بـmock.
//  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng).
//  لا يطبع سراً/كلمة مرور/بريداً كاملاً/توكناً — المسؤولية على المستدعي في السجل.
// =====================================================================

export const EXPECTED_PROJECT_REF = 'fibkwudabuwfjqpyeeng';
export const EXPECTED_HOST = `${EXPECTED_PROJECT_REF}.supabase.co`;
export const TARGETS = ['392', '5552', '2306'];
export const REPAIR_BATCH = 'leave-balances-auth-repair-202607';
export const emailFor = (no) => `e${no}@shift.local`;

const am = (u, k) => ((u && u.app_metadata) || {})[k];
const um = (u, k) => ((u && u.user_metadata) || {})[k];

// ---- تثبيت المشروع: يرفض ما لم يكن hostname مطابقاً تماماً ----
export function validateProjectUrl(rawUrl) {
  if (!rawUrl) return { ok: false, reason: 'SUPABASE_URL مفقود' };
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'SUPABASE_URL ليس رابطاً صالحاً' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'المطلوب https' };
  if (u.hostname !== EXPECTED_HOST) return { ok: false, reason: `hostname غير مطابق (المتوقّع ${EXPECTED_HOST})` };
  return { ok: true, ref: EXPECTED_PROJECT_REF };
}

// ---- فكّ payload لـJWT محلياً (بلا تحقّق توقيع؛ للكشف عن الدور فقط) ----
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch { return null; }
}

// ---- تحقّق المفتاح: sb_secret_ أو JWT بدور service_role فقط ----
export function validateSecretKey(secret) {
  if (!secret || typeof secret !== 'string') return { ok: false, reason: 'SUPABASE_SECRET_KEY مفقود' };
  if (secret.startsWith('sb_publishable_')) return { ok: false, reason: 'مفتاح publishable مرفوض' };
  if (secret.startsWith('sb_secret_')) return { ok: true, kind: 'secret' };
  const payload = decodeJwtPayload(secret);
  if (payload) {
    if (payload.role === 'service_role') return { ok: true, kind: 'service_role_jwt' };
    return { ok: false, reason: `JWT بدور «${payload.role || '?'}» مرفوض (المطلوب service_role)` };
  }
  return { ok: false, reason: 'نوع المفتاح غير معروف/غير صالح' };
}

// ---- probe صلاحيات قراءة فقط ----
export async function capabilityProbe(admin) {
  const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw new Error('فشل probe الصلاحيات: ' + (error.status === 401 ? '401 غير مخوّل' : (error.message || 'خطأ')));
  return true;
}

// ---- pagination كاملة عبر كل الصفحات ----
export async function listAllUsers(admin) {
  const all = [];
  const perPage = 1000;
  for (let page = 1; page <= 100000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error('listUsers: ' + (error.message || 'خطأ'));
    const users = (data && data.users) || [];
    all.push(...users);
    if (users.length < perPage) break;
  }
  return all;
}

export async function loadEmployees(admin, targets = TARGETS) {
  const { data, error } = await admin.from('employees').select('id,name,emp_no,team').in('emp_no', targets);
  if (error) throw new Error('قراءة employees: ' + (error.message || 'خطأ'));
  return data || [];
}

export async function employeeAuthEmpIds(admin, empIds) {
  if (!empIds.length) return new Set();
  const { data, error } = await admin.from('employee_auth').select('emp_id,user_id').in('emp_id', empIds);
  if (error) { if (error.code === '42P01') return new Set(); throw new Error('employee_auth: ' + (error.message || 'خطأ')); }
  return new Set((data || []).map((r) => r.emp_id));
}

// ---- خطة ذرّية: تُحسب لكل الأهداف قبل أي إنشاء ----
export function buildPlan({ employees, users, eauthEmpIds, targets = TARGETS }) {
  const byEmail = new Map(users.map((u) => [(u.email || '').toLowerCase(), u]));
  const empByNo = new Map();
  for (const e of employees) { const a = empByNo.get(e.emp_no) || []; a.push(e); empByNo.set(e.emp_no, a); }
  const plan = [];
  let hardStop = false;
  for (const no of targets) {
    const rows = empByNo.get(no) || [];
    const name = rows[0] ? rows[0].name : '(غير موجود)';
    const team = rows[0] ? rows[0].team : '';
    const expectedEmail = emailFor(no);
    const base = { emp_no: no, name, team, empId: rows[0] ? rows[0].id : null, expectedEmail };
    if (rows.length !== 1) { plan.push({ ...base, action: 'block', reason: `صفوف الموظف=${rows.length}` }); hardStop = true; continue; }
    if (!team) { plan.push({ ...base, action: 'block', reason: 'team فارغة' }); hardStop = true; continue; }
    if (eauthEmpIds && eauthEmpIds.has(rows[0].id)) { plan.push({ ...base, action: 'block', reason: 'employee_auth سابق' }); hardStop = true; continue; }
    const foreign = users.find((u) => (am(u, 'emp_no') === no || um(u, 'emp_no') === no) && (u.email || '').toLowerCase() !== expectedEmail.toLowerCase());
    if (foreign) { plan.push({ ...base, action: 'block', reason: 'تطابق غامض' }); hardStop = true; continue; }
    const exist = byEmail.get(expectedEmail.toLowerCase());
    if (exist) {
      const match = am(exist, 'role') === 'viewer' && am(exist, 'team') === team && um(exist, 'emp_no') === no;
      if (match) plan.push({ ...base, action: 'skip', reason: 'موجود ومتطابق' });
      else { plan.push({ ...base, action: 'conflict', reason: 'موجود لكن role/team/emp_no مختلفة' }); hardStop = true; }
      continue;
    }
    plan.push({ ...base, action: 'create', reason: 'مفقود' });
  }
  return { plan, hardStop };
}

// ---- تحقّق مستخدم مقابل صف الموظف ----
export function verifyUser(user, employee, { requireBatch = true } = {}) {
  const fails = [];
  if (!user) return ['لا مستخدم'];
  if ((user.email || '').toLowerCase() !== emailFor(employee.emp_no).toLowerCase()) fails.push('email');
  if (!user.email_confirmed_at) fails.push('email_confirmed_at');
  if (am(user, 'role') !== 'viewer') fails.push('role');
  if (am(user, 'team') !== employee.team) fails.push('team');       // مطابق للموظف لا قيمة ثابتة
  if (requireBatch && am(user, 'repair_batch') !== REPAIR_BATCH) fails.push('repair_batch');
  if (um(user, 'emp_no') !== employee.emp_no) fails.push('emp_no');
  if (!((user.identities || []).some((i) => i.provider === 'email'))) fails.push('email_identity');
  return fails;
}

// ---- التشغيل: Preflight ذرّي ثم إنشاء مع تعويض فشل جزئي ----
export async function runRepair({ admin, log = () => {}, dryRun = false }) {
  await capabilityProbe(admin);
  const employees = await loadEmployees(admin);
  const usersBefore = await listAllUsers(admin);
  const empIds = employees.map((e) => e.id);
  const eauthEmpIds = await employeeAuthEmpIds(admin, empIds);
  const { plan, hardStop } = buildPlan({ employees, users: usersBefore, eauthEmpIds });

  log('— Preflight —');
  for (const p of plan) log(`  ${p.name} [${p.team || '—'}] emp_no=${p.emp_no} → ${p.action} (${p.reason})`);

  const skipped = plan.filter((p) => p.action === 'skip').map((p) => p.emp_no);
  if (hardStop) { log('توقّف Preflight — لن يُنشأ أي حساب (لا إنشاء جزئي).'); return { status: 'BLOCKED', plan, created: [], skipped }; }
  if (dryRun) { log('DRY_RUN: لا إنشاء.'); return { status: 'DRY_RUN', plan, created: [], skipped }; }

  const empByNo = new Map(employees.map((e) => [e.emp_no, e]));
  const createdThisRun = []; // { id, emp_no }
  try {
    for (const p of plan.filter((x) => x.action === 'create')) {
      const e = empByNo.get(p.emp_no);
      const { data, error } = await admin.auth.admin.createUser({
        email: emailFor(p.emp_no),
        password: String(p.emp_no),            // = الرقم الوظيفي (لا يُطبع)
        email_confirm: true,
        app_metadata: { role: 'viewer', team: e.team, repair_batch: REPAIR_BATCH },
        user_metadata: { username: 'e' + p.emp_no, full_name: e.name, emp_no: p.emp_no },
      });
      if (error || !data || !data.user) throw new Error(`createUser فشل emp_no=${p.emp_no}: ${error ? error.message : 'لا مستخدم'}`);
      createdThisRun.push({ id: data.user.id, emp_no: p.emp_no });
      log(`✓ أُنشئ: ${e.name} [${e.team}] emp_no=${p.emp_no}`);
    }

    // إعادة القراءة: التحقّق ومنع التكرار
    const usersAfter = await listAllUsers(admin);
    const afterByEmail = new Map();
    for (const u of usersAfter) { const k = (u.email || '').toLowerCase(); afterByEmail.set(k, (afterByEmail.get(k) || []).concat(u)); }

    for (const p of plan) {
      if (p.action === 'block' || p.action === 'conflict') continue;
      const e = empByNo.get(p.emp_no);
      const matches = afterByEmail.get(emailFor(p.emp_no).toLowerCase()) || [];
      if (matches.length !== 1) throw new Error(`تكرار/غياب حساب emp_no=${p.emp_no} (عدد=${matches.length})`);
      let u = matches[0];
      if (admin.auth.admin.getUserById) { const g = await admin.auth.admin.getUserById(u.id); if (g && g.data && g.data.user) u = g.data.user; }
      const fails = verifyUser(u, e, { requireBatch: p.action === 'create' });
      if (fails.length) throw new Error(`تحقّق فشل emp_no=${p.emp_no}: ${fails.join(',')}`);
    }

    // الحسابات السابقة (غير الأهداف) لم تتغيّر
    const targetEmails = new Set(TARGETS.map((n) => emailFor(n).toLowerCase()));
    const beforeOthers = usersBefore.filter((u) => !targetEmails.has((u.email || '').toLowerCase()));
    const afterById = new Map(usersAfter.map((u) => [u.id, u]));
    for (const b of beforeOthers) {
      const a = afterById.get(b.id);
      if (!a || a.updated_at !== b.updated_at || (a.email || '') !== (b.email || '')) throw new Error('تغيّر حساب سابق');
    }

    const created = createdThisRun.map((c) => c.emp_no);
    log(`\nOK: أُنشئ ${created.length}، تخطٍّ ${skipped.length}.`);
    return { status: 'OK', plan, created, skipped };
  } catch (err) {
    log(`✗ فشل: ${err.message} — تعويض بحذف ما أُنشئ في هذا التشغيل فقط…`);
    const affected = [];
    for (const c of createdThisRun) {
      try {
        const g = await admin.auth.admin.getUserById(c.id);
        const u = g && g.data && g.data.user;
        if (!u || (u.app_metadata || {}).repair_batch !== REPAIR_BATCH) throw new Error('repair_batch غير مطابق — لن يُحذف');
        const { error } = await admin.auth.admin.deleteUser(c.id);
        if (error) throw new Error(error.message);
        log(`↩ حُذف (تعويض) emp_no=${c.emp_no}`);
      } catch (delErr) {
        affected.push(c.emp_no);
        log(`✗ تعذّر تعويض emp_no=${c.emp_no}: ${delErr.message}`);
      }
    }
    if (affected.length) return { status: 'PARTIAL_FAILURE', plan, created: createdThisRun.map((c) => c.emp_no), affected, error: err.message };
    return { status: 'FAILED_ROLLED_BACK', plan, created: [], affected: [], error: err.message };
  }
}

// ---- Rollback: حذف مشروط بكل الحراس ----
export async function hasEmployeeAuth(admin, userId) {
  const { data, error } = await admin.from('employee_auth').select('user_id').eq('user_id', userId);
  if (error) { if (error.code === '42P01') return false; throw new Error('employee_auth: ' + (error.message || 'خطأ')); }
  return (data || []).length > 0;
}

export async function runRollback({ admin, log = () => {}, dryRun = false }) {
  await capabilityProbe(admin);
  const users = await listAllUsers(admin);
  const byEmail = new Map(users.map((u) => [(u.email || '').toLowerCase(), u]));
  const employees = await loadEmployees(admin);
  const empByNo = new Map(employees.map((e) => [e.emp_no, e]));

  let deleted = 0, skipped = 0;
  for (const no of TARGETS) {
    const e = empByNo.get(no);
    const name = e ? e.name : 'موظف';
    const u = byEmail.get(emailFor(no).toLowerCase());
    if (!u) { log(`تخطٍّ: لا حساب emp_no=${no} (${name})`); skipped++; continue; }
    const linked = await hasEmployeeAuth(admin, u.id);   // leaves تشير لـemp_id لا user_id؛ الرابط الوحيد employee_auth
    const guards = {
      inTargets: TARGETS.includes(no),
      email: (u.email || '').toLowerCase() === emailFor(no).toLowerCase(),
      repairBatch: (u.app_metadata || {}).repair_batch === REPAIR_BATCH,   // يثبت أنه من دفعة الإصلاح (لم يكن موجوداً قبلها)
      role: (u.app_metadata || {}).role === 'viewer',
      team: e ? (u.app_metadata || {}).team === e.team : false,
      empNo: (u.user_metadata || {}).emp_no === no,
      noEmployeeAuth: !linked,
    };
    if (!Object.values(guards).every(Boolean)) { log(`تخطٍّ (حراس غير مطابقة) emp_no=${no}: ${JSON.stringify(guards)}`); skipped++; continue; }
    if (dryRun) { log(`DRY_RUN: سيُحذف emp_no=${no} (${name})`); skipped++; continue; }
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`حذف emp_no=${no}: ${error.message}`);
    log(`✓ حُذف emp_no=${no} (${name})`);
    deleted++;
  }
  log(`\nحُذف ${deleted}، تخطٍّ ${skipped}${dryRun ? ' (DRY_RUN)' : ''}.`);
  return { status: 'OK', deleted, skipped };
}
