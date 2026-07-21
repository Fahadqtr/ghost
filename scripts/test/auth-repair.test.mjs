// اختبارات mock لمنطق إصلاح حسابات Auth — تعمل ببناء Node فقط (node --test)،
// لا تتطلّب @supabase/supabase-js ولا شبكة. لا تلمس Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProjectUrl, validateSecretKey, decodeJwtPayload,
  buildPlan, runRepair, runRollback, listAllUsers,
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
  constructor({ users = [], employees = EMP, employeeAuth = [], failCreateEmpNo = null, failDeleteId = null } = {}) {
    this.users = users.map((u) => ({ ...u }));
    this.employees = employees;
    this.employeeAuth = employeeAuth;
    this.failCreateEmpNo = failCreateEmpNo;
    this.failDeleteId = failDeleteId;
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
        if (self.failCreateEmpNo && empNo === self.failCreateEmpNo) return { data: null, error: { message: 'mock create fail' } };
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
    const rows = table === 'employees' ? self.employees : table === 'employee_auth' ? self.employeeAuth : [];
    return { select() { return {
      in(col, vals) { return Promise.resolve({ data: rows.filter((r) => vals.includes(r[col])), error: null }); },
      eq(col, val) { return Promise.resolve({ data: rows.filter((r) => r[col] === val), error: null }); },
    }; } };
  }
}

// ============================ الاختبارات ============================

test('project URL: يرفض مشروعاً خاطئاً ويقبل المطابق', () => {
  assert.equal(validateProjectUrl('https://other-proj.supabase.co').ok, false);
  assert.equal(validateProjectUrl('http://fibkwudabuwfjqpyeeng.supabase.co').ok, false); // ليس https
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
  const admin = new MockAdmin({ users: [madeUser('5552', { team: 'w2' })] }); // team مختلف = conflict
  const res = await runRepair({ admin });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(admin.createCount, 0);
});

test('runRepair: إنشاء ثلاثة بنجاح ثم التحقق', async () => {
  const admin = new MockAdmin({ users: [] });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.created.sort(), ['2306', '392', '5552']);
  assert.equal(admin.createCount, 3);
  // team مأخوذ من صف الموظف (w1)
  for (const no of TARGETS) {
    const u = admin.users.find((x) => x.email === emailFor(no));
    assert.equal(u.app_metadata.role, 'viewer');
    assert.equal(u.app_metadata.team, 'w1');
    assert.equal(u.app_metadata.repair_batch, REPAIR_BATCH);
    assert.equal(u.user_metadata.emp_no, no);
    assert.ok(u.email_confirmed_at);
  }
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
  // 392 أُنشئ ثم حُذف بالتعويض
  assert.equal(admin.users.some((u) => u.email === emailFor('392')), false);
  assert.equal(admin.deleteCount, 1);
  // الحساب السابق سليم
  assert.ok(admin.users.find((u) => u.id === 'pre-1'));
});

test('runRepair: فشل التعويض ينتج PARTIAL_FAILURE بأرقام متأثرة', async () => {
  // 392 يُنشأ بـid=uid-1، 5552 يفشل، ثم حذف uid-1 يفشل
  const admin = new MockAdmin({ users: [], failCreateEmpNo: '5552', failDeleteId: 'uid-1' });
  const res = await runRepair({ admin });
  assert.equal(res.status, 'PARTIAL_FAILURE');
  assert.deepEqual(res.affected, ['392']);
  // 392 ما يزال موجوداً (تعذّر حذفه) — يتطلّب تدخلاً يدوياً
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

test('runRollback: يحذف فقط عند تطابق كل الحراس، ويتخطّى غير المطابق', async () => {
  const good = madeUser('392');
  const wrongBatch = madeUser('5552', { batch: 'other' });
  const admin = new MockAdmin({ users: [good, wrongBatch] });
  const res = await runRollback({ admin });
  assert.equal(res.deleted, 1);                   // 392 فقط
  assert.equal(admin.users.some((u) => u.email === emailFor('392')), false);
  assert.equal(admin.users.some((u) => u.email === emailFor('5552')), true); // batch مختلف ⇒ تخطٍّ
});

test('runRollback: DRY_RUN لا يحذف', async () => {
  const admin = new MockAdmin({ users: [madeUser('392')] });
  const res = await runRollback({ admin, dryRun: true });
  assert.equal(res.deleted, 0);
  assert.equal(admin.deleteCount, 0);
  assert.ok(admin.users.find((u) => u.email === emailFor('392')));
});

test('runRollback: لا يحذف إذا كان employee_auth مرتبطاً', async () => {
  const u = madeUser('392', { id: 'uid-392' });
  const admin = new MockAdmin({ users: [u], employeeAuth: [{ emp_id: 'e1', user_id: 'uid-392' }] });
  const res = await runRollback({ admin });
  assert.equal(res.deleted, 0);
  assert.ok(admin.users.find((x) => x.id === 'uid-392'));
});
