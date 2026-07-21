#!/usr/bin/env node
// =====================================================================
//  إصلاح حسابات Auth الناقصة عبر Supabase Auth Admin API (خادميّ فقط).
//  المشروع المستهدف حصراً: shift-scheduler.
//  الأهداف: الأرقام الوظيفية 392 / 5552 / 2306 فقط.
//
//  ممنوع: وضع المفتاح في الكود، طباعته، استخدام publishable key، التشغيل
//  في المتصفح. يقرأ SUPABASE_URL و SUPABASE_SECRET_KEY من البيئة فقط.
//  لا يطبع كلمة المرور ولا البريد الكامل (يُعرَّف بالاسم والوردية).
//
//  التشغيل (لا تُشغّله إلا بموافقة):
//    SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/repair-missing-auth-users.mjs
//    (DRY_RUN=1 يقف بعد الفحص دون إنشاء)
// =====================================================================
import { createClient } from '@supabase/supabase-js';

const TARGETS = ['392', '5552', '2306'];
const REPAIR_BATCH = 'leave-balances-auth-repair-202607';
const EMAIL = (n) => `e${n}@shift.local`;          // يُبنى محلياً، لا يُطبع

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!url || !secret) {
  console.error('ERROR: مطلوب SUPABASE_URL و SUPABASE_SECRET_KEY من البيئة (secret/service key، ليس publishable).');
  process.exit(2);
}
if (/publishable|anon/i.test(secret) || secret.startsWith('sb_publishable')) {
  console.error('ERROR: المفتاح يبدو publishable/anon — Admin API يتطلّب secret/service key.');
  process.exit(2);
}

const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
const am = (u, k) => (u.app_metadata || {})[k];
const um = (u, k) => (u.user_metadata || {})[k];
const fail = (m) => console.error('✗ ' + m);
const info = (m) => console.log(m);

async function loadEmployees() {
  const { data, error } = await admin.from('employees').select('id,name,emp_no,team').in('emp_no', TARGETS);
  if (error) throw new Error('قراءة employees: ' + error.message);
  return data || [];
}
async function listAllUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error('listUsers: ' + error.message);
  return data.users || [];
}
async function employeeAuthFor(empIds) {
  if (!empIds.length) return [];
  const { data, error } = await admin.from('employee_auth').select('emp_id,user_id').in('emp_id', empIds);
  if (error) { if (error.code === '42P01') return []; throw new Error('employee_auth: ' + error.message); }
  return data || [];
}

(async () => {
  const employees = await loadEmployees();
  const users = await listAllUsers();
  const byEmail = new Map(users.map((u) => [(u.email || '').toLowerCase(), u]));

  const empByNo = new Map();
  for (const e of employees) { const a = empByNo.get(e.emp_no) || []; a.push(e); empByNo.set(e.emp_no, a); }
  const empIds = employees.map((e) => e.id);
  const eauthByEmp = new Set((await employeeAuthFor(empIds)).map((r) => r.emp_id));

  // ---- Preflight (بلا بريد/سر) ----
  const plan = [];
  let hardStop = false;
  for (const no of TARGETS) {
    const rows = empByNo.get(no) || [];
    const name = rows[0]?.name || '(غير موجود)';
    const team = rows[0]?.team || '';
    if (rows.length !== 1) { plan.push({ no, name, team, action: 'block', reason: `صفوف الموظف=${rows.length} (المتوقّع 1)` }); hardStop = true; continue; }
    if (!team) { plan.push({ no, name, team, action: 'block', reason: 'team فارغة' }); hardStop = true; continue; }
    if (eauthByEmp.has(rows[0].id)) { plan.push({ no, name, team, action: 'block', reason: 'employee_auth سابق' }); hardStop = true; continue; }
    // تطابق غامض: مستخدم آخر يحمل نفس الرقم لكن ببريد مختلف
    const foreign = users.find((u) => (am(u, 'emp_no') === no || um(u, 'emp_no') === no) && (u.email || '').toLowerCase() !== EMAIL(no).toLowerCase());
    if (foreign) { plan.push({ no, name, team, action: 'block', reason: 'مستخدم آخر يحمل نفس الرقم (تطابق غامض)' }); hardStop = true; continue; }
    const exist = byEmail.get(EMAIL(no).toLowerCase());
    if (exist) {
      const match = am(exist, 'role') === 'viewer' && am(exist, 'team') === team && um(exist, 'emp_no') === no;
      if (match) { plan.push({ no, name, team, action: 'skip', reason: 'موجود ومتطابق (idempotent)' }); }
      else { plan.push({ no, name, team, action: 'conflict', reason: 'موجود لكن role/team/emp_no مختلفة' }); hardStop = true; }
      continue;
    }
    plan.push({ no, name, team, action: 'create', reason: 'مفقود' });
  }

  info('— Preflight —');
  for (const p of plan) info(`  ${p.name} [${p.team || '—'}] → ${p.action} (${p.reason})`);
  if (hardStop) { fail('توقّف Preflight — لن يُنشأ أي مستخدم (لا إنشاء جزئي).'); process.exit(1); }
  if (DRY_RUN) { info('\nDRY_RUN: توقّف بعد الفحص دون إنشاء.'); process.exit(0); }

  // ---- الإنشاء ----
  let createdCount = 0;
  for (const p of plan.filter((x) => x.action === 'create')) {
    const e = empByNo.get(p.no)[0];
    const { error } = await admin.auth.admin.createUser({
      email: EMAIL(p.no),
      password: String(p.no),                 // = الرقم الوظيفي (لا يُطبع)
      email_confirm: true,
      app_metadata: { role: 'viewer', team: e.team, repair_batch: REPAIR_BATCH },
      user_metadata: { username: 'e' + p.no, full_name: e.name, emp_no: p.no },
    });
    if (error) { fail(`فشل إنشاء ${p.name}: ${error.message}`); process.exit(1); }
    createdCount++; info(`✓ أُنشئ: ${p.name} [${e.team}]`);
  }
  const skipped = plan.filter((x) => x.action === 'skip').length;
  info(`\nأُنشئ ${createdCount}، تخطٍّ ${skipped}.`);

  // ---- التحقّق بعد الإنشاء (getUserById للهويات) ----
  const after = await listAllUsers();
  const afterByEmail = new Map(after.map((u) => [(u.email || '').toLowerCase(), u]));
  let vfail = 0;
  for (const no of TARGETS) {
    const e = empByNo.get(no)[0];
    const brief = afterByEmail.get(EMAIL(no).toLowerCase());
    if (!brief) { fail(`تحقّق: لا مستخدم لـ ${e.name}`); vfail++; continue; }
    const { data: full, error } = await admin.auth.admin.getUserById(brief.id);
    const u = full?.user;
    if (error || !u) { fail(`تحقّق: getUserById فشل (${e.name})`); vfail++; continue; }
    if (!u.email_confirmed_at) { fail(`تحقّق: email_confirmed_at غائبة (${e.name})`); vfail++; }
    if (am(u, 'role') !== 'viewer') { fail(`تحقّق: role≠viewer (${e.name})`); vfail++; }
    if (am(u, 'team') !== 'w1') { fail(`تحقّق: team≠w1 (${e.name})`); vfail++; }
    if (!(u.identities || []).some((i) => i.provider === 'email')) { fail(`تحقّق: لا email identity (${e.name})`); vfail++; }
  }
  // الستة السابقون لم يتغيّروا
  const targetEmails = new Set(TARGETS.map((n) => EMAIL(n).toLowerCase()));
  const beforeOthers = users.filter((u) => !targetEmails.has((u.email || '').toLowerCase()));
  const afterById = new Map(after.map((u) => [u.id, u]));
  for (const b of beforeOthers) {
    const a = afterById.get(b.id);
    if (!a) { fail('تحقّق: مستخدم سابق اختفى!'); vfail++; continue; }
    if (a.updated_at !== b.updated_at || (a.email || '') !== (b.email || '')) { fail('تحقّق: تغيّر مستخدم سابق!'); vfail++; }
  }
  // employee_auth لم يُنشأ بعد
  if ((await employeeAuthFor(empIds)).length > 0) { fail('تحقّق: employee_auth أُنشئ (يجب ألا يُنشأ الآن)'); vfail++; }

  info(vfail === 0
    ? '\n✓ التحقّق ناجح: حسابات viewer/w1 مؤكّدة (email_confirmed + email identity)، الستة سليمة، بلا employee_auth.'
    : `\n✗ فشل التحقّق (${vfail}).`);
  process.exit(vfail === 0 ? 0 : 1);
})().catch((e) => { console.error('خطأ: ' + (e && e.message ? e.message : String(e))); process.exit(1); });
