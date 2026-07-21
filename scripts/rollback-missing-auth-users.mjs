#!/usr/bin/env node
// =====================================================================
//  Rollback حسابات Auth التي أنشأها الإصلاح — عبر Supabase Auth Admin API.
//  يحذف حساباً واحداً فقط عند تحقّق كل الشروط، وإلا يتخطّاه (لا يحذف).
//  الشروط: البريد ضمن الأرقام الثلاثة · repair_batch مطابق · role=viewer ·
//          team=w1 · لا employee_auth مرتبط به.
//  ممنوع: المفتاح في الكود/السجل، publishable key، المتصفح، طباعة أسرار/بريد.
//
//  التشغيل: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/rollback-missing-auth-users.mjs
// =====================================================================
import { createClient } from '@supabase/supabase-js';

const TARGETS = ['392', '5552', '2306'];
const REPAIR_BATCH = 'leave-balances-auth-repair-202607';
const EMAIL = (n) => `e${n}@shift.local`;

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) { console.error('ERROR: مطلوب SUPABASE_URL و SUPABASE_SECRET_KEY (secret key).'); process.exit(2); }
if (/publishable|anon/i.test(secret) || secret.startsWith('sb_publishable')) { console.error('ERROR: مفتاح publishable/anon غير مسموح.'); process.exit(2); }

const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
const am = (u, k) => (u.app_metadata || {})[k];

async function listAllUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error('listUsers: ' + error.message);
  return data.users || [];
}
async function hasEmployeeAuth(userId) {
  const { data, error } = await admin.from('employee_auth').select('user_id').eq('user_id', userId);
  if (error) { if (error.code === '42P01') return false; throw new Error('employee_auth: ' + error.message); }
  return (data || []).length > 0;
}

(async () => {
  const users = await listAllUsers();
  const byEmail = new Map(users.map((u) => [(u.email || '').toLowerCase(), u]));
  const { data: emps, error: eErr } = await admin.from('employees').select('name,emp_no').in('emp_no', TARGETS);
  if (eErr) throw new Error('employees: ' + eErr.message);
  const nameByNo = new Map((emps || []).map((e) => [e.emp_no, e.name]));

  let deleted = 0, skipped = 0;
  for (const no of TARGETS) {
    const label = nameByNo.get(no) || 'موظف';
    const u = byEmail.get(EMAIL(no).toLowerCase());
    if (!u) { console.log(`تخطٍّ: لا حساب لـ ${label}`); skipped++; continue; }
    const cond = {
      emailInTargets: (u.email || '').toLowerCase() === EMAIL(no).toLowerCase(),
      repairBatch: am(u, 'repair_batch') === REPAIR_BATCH,
      roleViewer: am(u, 'role') === 'viewer',
      teamW1: am(u, 'team') === 'w1',
    };
    const linked = await hasEmployeeAuth(u.id);
    const ok = cond.emailInTargets && cond.repairBatch && cond.roleViewer && cond.teamW1 && !linked;
    if (!ok) {
      console.log(`تخطٍّ (شروط غير مطابقة) ${label}: ${JSON.stringify({ ...cond, employee_auth_linked: linked })}`);
      skipped++; continue;
    }
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) { console.error(`فشل حذف ${label}: ${error.message}`); process.exit(1); }
    console.log(`✓ حُذف: ${label}`);
    deleted++;
  }
  console.log(`\nالنتيجة: حُذف ${deleted}، تخطٍّ ${skipped}.`);
  process.exit(0);
})().catch((e) => { console.error('خطأ: ' + (e && e.message ? e.message : String(e))); process.exit(1); });
