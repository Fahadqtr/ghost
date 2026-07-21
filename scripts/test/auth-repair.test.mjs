// اختبارات mock لمنطق إصلاح حسابات Auth — تعمل ببناء Node فقط (node --test)،
// لا تتطلّب @supabase/supabase-js ولا شبكة. لا تلمس Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProjectUrl, validateSecretKey, decodeJwtPayload,
  buildPlan, verifyUser, runRepair, runRollback, listAllUsers,
  repairWriteAllowed, rollbackWriteAllowed, sanitizeErrorMessage, normalizeEmpNo,
  REPAIR_BATCH, TARGETS, emailFor,
} from '../lib/auth-repair-core.mjs';

// ---- أدوات ----
function jwt(role) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ role })}.sig`;
}
const EMP = [
  { id: 'e1', name: 'موظف ألف', emp_no: '392', team: 'w1' },
  { id: 'e2', name: 'موظف باء', emp_no: '5552', team: 'w1' },
  { id: 'e3', name: 'موظف جيم', emp_no: '2306', team: 'w1' },
];
function madeUser(no, { role = 'viewer', team = 'w1', batch = REPAIR_BATCH, confirmed = true, identity = true, emp_no = no, id } = {}) {
  return {
    id: id || ('ex-' + no), email: emailFor(no), email_confirmed_at: confirmed ? 't' : null,
    app_metadata: { role, team, repair_batch: batch }, user_metadata: { emp_no, username: 'e' + no, full_name: 'X' },
    identities: identity ? [{ provider: 'email' }] : [], updated_at: 't0',
  };
}

class MockAdmin {
  constructor(opts = {}) {
    this.users = (opts.users || []).map((u) => ({ ...u }));
    this.tables = {
      employees: opts.employees || EMP,
      employee_auth: opts.employeeAuth || [],
      audit_log: opts.auditLog || [],
      leave_ledger: opts.leaveLedger || [],
      leave_policies: opts.leavePolicies || [],
      leaves: opts.leaves || [],
    };
    this.tableErrors = opts.tableErrors || {};   // table -> { code, message }
    this.failCreateEmpNo = opts.failCreateEmpNo || null;
    this.failDeleteId = opts.failDeleteId || null;
    this.createCount = 0; this.deleteCount = 0;
    let seq = 1;
    const self = this;
    this.auth = { admin: {
      async listUsers({ page = 1, perPage = 1000 } = {}) {
        const start = (page - 1) * perPage;
        return { data: { users: self.users.slice(start, start + perPage).map((u) => ({ ...u })) }, error: null };
      },
      async createUser(payload) {
        const empNo = payload.user_metadata && payload.user_metadata.emp_no;
        if (self.failCreateEmpNo && String(empNo) === String(self.failCreateEmpNo)) return { data: null, error: { message: 'mock create fail' } };
        self.createCount++;
        const u = {
          id: 'uid-' + (seq++), email: payload.email,
          email_confirmed_at: payload.email_confirm ? 't' : null,
          app_metadata: { ...(payload.app_metadata || {}) },
          user_metadata: { ...(payload.user_metadata || {}) },
          identities: [{ provider: 'email' }], updated_at: 'tn',
        };
        self.users.push(u);
        return { data: { user: { ...u } }, error: null };
      },
      async getUserById(id) {
        const u = self.users.find((x) => x.id === id);
        return u ? { data: { user: { ...u } }, error: null } : { data: null, error: { message: 'not found' } };
      },
      async deleteUser(id) {
        if (self.failDeleteId && id === self.failDeleteId) return { error: { message: 'mock delete fail' } };
        const i = self.users.findIndex((x) => x.id === id);
        if (i >= 0) { self.users.splice(i, 1); self.deleteCount++; return { data: {}, error: null }; }
        return { error: { message: 'not found' } };
      },
    } };
  }
  from(table) {
    const self = this;
    const err = self.tableErrors[table];
    const rows = self.tables[table] || [];
    const run = (fn) => (err ? Promise.resolve({ data: null, error: err }) : Promise.resolve({ data: rows.filter(fn), error: null }));
    return { select() { return {
      in(col, vals) { return run((r) => vals.includes(r[col])); },
      eq(col, val) { return run((r) => r[col] === val); },
    }; } };
  }
}

// ============================ اختبارات التحقّق الشكلي ============================

test('project URL: يرفض مشروعاً خاطئاً ويقبل المطابق', () => {
  assert.equal(validateProjectUrl('https://other-proj.supabase.co').ok, false);
  assert.equal(validateProjectUrl('http://fibkwudabuwfjqpyeeng.supabase.co').ok, false);
  assert.equal(validateProjectUrl('حبل عشوائي').ok, false);
  assert.equal(validateProjectUrl('https://fibkwudabuwfjqpyeeng.supabase.co').ok, true);
});

test('المفتاح: يرفض publishable و anon والنص العشوائي، ويقبل secret/service_role', () => {
  assert.equal(validateSecretKey('sb_publishable_abc').ok, false);
  assert.equal(validateSecretKey(jwt('anon')).ok, false);
  assert.equal(validateSecretKey('نص عشوائي بلا معنى').ok, false);
  assert.equal(validateSecretKey('sb_secret_abc').ok, true);
  assert.equal(validateSecretKey(jwt('service_role')).ok, true);
  assert.equal(decodeJwtPayload(jwt('service_role')).role, 'service_role');
});

test('تأكيد الكتابة: الإنشاء يُرفض بلا APPLY_AUTH_REPAIR', () => {
  assert.equal(repairWriteAllowed({}).ok, false);
  assert.equal(repairWriteAllowed({ APPLY_AUTH_REPAIR: 'خطأ' }).ok, false);
  assert.deepEqual(repairWriteAllowed({ DRY_RUN: '1' }), { ok: true, dryRun: true });
  assert.deepEqual(repairWriteAllowed({ APPLY_AUTH_REPAIR: 'YES_CREATE_3_USERS' }), { ok: true, dryRun: false });
});

test('تأكيد الكتابة: الحذف يُرفض بلا APPLY_AUTH_ROLLBACK', () => {
  assert.equal(rollbackWriteAllowed({}).ok, false);
  assert.equal(rollbackWriteAllowed({ APPLY_AUTH_ROLLBACK: 'خطأ' }).ok, false);
  assert.deepEqual(rollbackWriteAllowed({ DRY_RUN: '1' }), { ok: true, dryRun: true });
  assert.deepEqual(rollbackWriteAllowed({ APPLY_AUTH_ROLLBACK: 'YES_DELETE_REPAIR_USERS' }), { ok: true, dryRun: false });
});

test('sanitizeErrorMessage: يخفي البريد/الرابط/التوكن ويُبقي emp_no والكود', () => {
  const msg = 'فشل لـ foo@shift.local على https://fibkwudabuwfjqpyeeng.supabase.co token eyJabcdefghijklmnop code PGRST205 emp_no=392';
  const s = sanitizeErrorMessage(msg, { url: 'https://fibkwudabuwfjqpyeeng.supabase.co' });
  assert.ok(!s.includes('foo@shift.local'));
  assert.ok(!s.includes('supabase.co'));
  assert.ok(!s.includes('eyJabcdefghijklmnop'));
  assert.ok(s.includes('PGRST205'));      // كود الخطأ يبقى
  assert.ok(s.includes('emp_no=392'));    // emp_no يبقى
});

// ============================ normalizeEmpNo ============================

test('normalizeEmpNo: 392 و"392" متطابقان', () => {
  assert.equal(normalizeEmpNo(392), '392');
  assert.equal(normalizeEmpNo(' 392 '), '392');
  assert.equal(normalizeEmpNo('392'), normalizeEmpNo(392));
  assert.equal(normalizeEmpNo(null), '');
});

test('buildPlan: emp_no رقمي في employees و metadata يعمل بلا conflict/missing', () => {
  const numericEmp = [{ id: 'e1', name: 'A', emp_no: 392, team: 'w1' }, { id: 'e2', name: 'B', emp_no: 5552, team: 'w1' }, { id: 'e3', name: 'C', emp_no: 2306, team: 'w1' }];
  const userNumericMeta = { email: emailFor('392'), email_confirmed_at: 't', app_metadata: { role: 'viewer', team: 'w1', repair_batch: REPAIR_BATCH }, user_metadata: { emp_no: 392 }, identities: [{ provider: 'email' }] };
  const { plan, hardStop } = buildPlan({ employees: numericEmp, users: [userNumericMeta], eauthEmpIds: new Set() });
  assert.equal(hardStop, false);
  assert.equal(plan.find((p) => p.emp_no === '392').action, 'skip');       // ليس conflict ولا block
  assert.equal(plan.find((p) => p.emp_no === '5552').action, 'create');
});

// ============================ verifyUser identity ============================

test('verifyUser: هوية email ببريد مختلف تفشل', () => {
  const u = { email: emailFor('392'), email_confirmed_at: 't', app_metadata: { role: 'viewer', team: 'w1', repair_batch: REPAIR_BATCH }, user_metadata: { emp_no: '392' }, identities: [{ provider: 'email', identity_data: { email: 'wrong@shift.local' } }] };
  const fails = verifyUser(u, EMP[0], { requireBatch: true });
  assert.ok(fails.includes('email_identity_mismatch'));
});

test('verifyUser: هوية email مطابقة أو بلا identity_data تنجح', () => {
  const good = { email: emailFor('392'), email_confirmed_at: 't', app_metadata: { role: 'viewer', team: 'w1', repair_batch: REPAIR_BATCH }, user_metadata: { emp_no: '392' }, identities: [{ provider: 'email', identity_data: { email: emailFor('392') } }] };
  assert.deepEqual(verifyUser(good, EMP[0], { requireBatch: true }), []);
  const noData = { ...good, identities: [{ provider: 'email' }] };
  assert.deepEqual(verifyUser(noData, EMP[0], { requireBatch: true }), []);
});

// ============================ buildPlan / runRepair ============================

test('buildPlan: مستخدم موجود ومتطابق = skip', () => {
  const { plan, hardStop } = buildPlan({ employees: EMP, users: [madeUser('392')], eauthEmpIds: new Set() });
  assert.equal(hardStop, false);
  assert.equal(plan.find((p) => p.emp_no === '392').action, 'skip');
  assert.equal(plan.find((p) => p.emp_no === '5552').action, 'create');
});

test('buildPlan: مستخدم موجود ومختلف = conflict + hardStop', () => {
  const { plan, hardStop } = buildPlan({ employees: EMP, users: [madeUser('392', { role: 'admin' })], eauthEmpIds: new Set() });
  assert.equal(hardStop, true);
  assert.equal(plan.find((p) => p.emp_no === '392').action, 'conflict');
});

test('runRepair: conflict يوقف قبل أي إنشاء', async () => {
  const admin = new MockAdmin({ users: [madeUser('5552', { team: 'w2' })] });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(admin.createCount, 0);
});

test('runRepair: إنشاء ثلاثة بنجاح ثم التحقق (team من صف الموظف)', async () => {
  const admin = new MockAdmin({ users: [] });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.created.sort(), ['2306', '392', '5552']);
  assert.equal(admin.createCount, 3);
  for (const no of TARGETS) {
    const u = admin.users.find((x) => x.email === emailFor(no));
    assert.equal(u.app_metadata.role, 'viewer');
    assert.equal(u.app_metadata.team, 'w1');
    assert.equal(u.app_metadata.repair_batch, REPAIR_BATCH);
    assert.equal(u.user_metadata.emp_no, no);
    assert.ok(u.email_confirmed_at);
  }
});

test('runRepair: employee_auth غير موجود (PGRST205) لا يُفشل الإصلاح', async () => {
  const admin = new MockAdmin({ users: [], tableErrors: { employee_auth: { code: 'PGRST205', message: 'relation not found' } } });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'OK');
  assert.equal(admin.createCount, 3);
});

test('runRepair: employee_auth بخطأ آخر (مثل 42501 صلاحية) يُفشل (لا يُتجاهَل)', async () => {
  const admin = new MockAdmin({ users: [], tableErrors: { employee_auth: { code: '42501', message: 'permission denied' } } });
  await assert.rejects(() => runRepair({ admin }), /employee_auth/);
});

test('runRepair: إعادة التشغيل بعد النجاح = 3 skipped بلا إنشاء', async () => {
  const admin = new MockAdmin({ users: TARGETS.map((n) => madeUser(n)) });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'OK');
  assert.equal(res.created.length, 0);
  assert.deepEqual(res.skipped.sort(), ['2306', '392', '5552']);
  assert.equal(admin.createCount, 0);
});

test('runRepair: فشل إنشاء الثاني يحذف الأول (تعويض) ولا يمسّ السابقين', async () => {
  const pre = { id: 'pre-1', email: 'salemm@shift.local', app_metadata: { role: 'admin', team: 'w1' }, user_metadata: {}, identities: [{ provider: 'email' }], updated_at: 't0' };
  const admin = new MockAdmin({ users: [pre], failCreateEmpNo: '5552' });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'FAILED_ROLLED_BACK');
  assert.equal(admin.users.some((u) => u.email === emailFor('392')), false);
  assert.equal(admin.deleteCount, 1);
  assert.ok(admin.users.find((u) => u.id === 'pre-1'));
});

test('runRepair: فشل التعويض ينتج PARTIAL_FAILURE بأرقام متأثرة', async () => {
  const admin = new MockAdmin({ users: [], failCreateEmpNo: '5552', failDeleteId: 'uid-1' });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'PARTIAL_FAILURE');
  assert.deepEqual(res.affected, ['392']);
  assert.ok(admin.users.find((u) => u.email === emailFor('392')));
});

test('runRepair: employee_auth سابق يوقف (block)', async () => {
  const admin = new MockAdmin({ users: [], employeeAuth: [{ emp_id: 'e1', user_id: 'x' }] });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(admin.createCount, 0);
});

test('listAllUsers: pagination لأكثر من 1000 مستخدم', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: 'u' + i, email: 'u' + i + '@x', app_metadata: {}, user_metadata: {}, identities: [] }));
  const admin = new MockAdmin({ users: many });
  const all = await listAllUsers(admin);
  assert.equal(all.length, 2500);
});

// ============================ runRollback ============================

test('runRollback: يحذف فقط عند تطابق كل الحراس، ويتخطّى غير المطابق', async () => {
  const good = madeUser('392', { id: 'uid-392' });
  const wrongBatch = madeUser('5552', { batch: 'other' });
  const admin = new MockAdmin({ users: [good, wrongBatch] });
  const res = await runRollback({ admin });
  assert.equal(res.deleted, 1);
  assert.equal(admin.users.some((u) => u.email === emailFor('392')), false);
  assert.equal(admin.users.some((u) => u.email === emailFor('5552')), true);
});

test('runRollback: DRY_RUN لا يحذف', async () => {
  const admin = new MockAdmin({ users: [madeUser('392', { id: 'uid-392' })] });
  const res = await runRollback({ admin, dryRun: true });
  assert.equal(res.deleted, 0);
  assert.equal(admin.deleteCount, 0);
  assert.ok(admin.users.find((u) => u.email === emailFor('392')));
});

test('runRollback: رابط employee_auth يمنع الحذف', async () => {
  const u = madeUser('392', { id: 'uid-392' });
  const admin = new MockAdmin({ users: [u], employeeAuth: [{ emp_id: 'e1', user_id: 'uid-392' }] });
  const res = await runRollback({ admin });
  assert.equal(res.deleted, 0);
  assert.ok(admin.users.find((x) => x.id === 'uid-392'));
});

test('runRollback: رابط audit_log.actor_id يمنع الحذف (يُظهر الجدول والعدد فقط)', async () => {
  const u = madeUser('392', { id: 'uid-392' });
  const logs = [];
  const admin = new MockAdmin({ users: [u], auditLog: [{ actor_id: 'uid-392' }, { actor_id: 'uid-392' }] });
  const res = await runRollback({ admin, log: (m) => logs.push(m) });
  assert.equal(res.deleted, 0);
  assert.ok(admin.users.find((x) => x.id === 'uid-392'));
  assert.ok(logs.some((l) => l.includes('audit_log=2')));   // اسم الجدول والعدد فقط
});

test('runRollback: جداول/أعمدة الروابط غير موجودة (PGRST205/PGRST204) لا تمنع الحذف', async () => {
  const admin = new MockAdmin({
    users: [madeUser('392', { id: 'uid-392' })],
    tableErrors: {
      employee_auth: { code: 'PGRST205' }, leave_ledger: { code: 'PGRST205' },
      leave_policies: { code: 'PGRST205' }, leaves: { code: 'PGRST204' }, audit_log: { code: 'PGRST205' },
    },
  });
  const res = await runRollback({ admin });
  assert.equal(res.deleted, 1);
  assert.equal(admin.users.some((u) => u.email === emailFor('392')), false);
});

test('runRollback: خطأ صلاحية على جدول رابط يُرفَع (لا يُتجاهَل)', async () => {
  const admin = new MockAdmin({ users: [madeUser('392', { id: 'uid-392' })], tableErrors: { audit_log: { code: '42501', message: 'permission denied' } } });
  await assert.rejects(() => runRollback({ admin }), /audit_log/);
});
