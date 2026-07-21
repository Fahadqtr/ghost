#!/usr/bin/env node
// =====================================================================
//  Rollback حسابات Auth التي أنشأها الإصلاح — عبر Supabase Auth Admin API.
//  يثبت المشروع والمفتاح بنفس طريقة سكربت الإنشاء. DRY_RUN=1 مدعوم.
//  يحذف حساباً فقط عند تطابق كل الحراس (repair_batch/role/team/email/employee_auth).
//  لا يطبع سراً/كلمة مرور/بريداً كاملاً/توكناً.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { validateProjectUrl, validateSecretKey, runRollback } from './lib/auth-repair-core.mjs';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';

const pu = validateProjectUrl(url);
if (!pu.ok) { console.error('ERROR: ' + pu.reason); process.exit(2); }
const pk = validateSecretKey(secret);
if (!pk.ok) { console.error('ERROR: ' + pk.reason); process.exit(2); }

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

runRollback({ admin, log: (m) => console.log(m), dryRun: DRY_RUN })
  .then(() => process.exit(0))
  .catch((e) => { console.error('خطأ: ' + (e && e.message ? e.message : String(e))); process.exit(1); });
