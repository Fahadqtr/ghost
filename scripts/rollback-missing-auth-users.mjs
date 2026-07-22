#!/usr/bin/env node
// =====================================================================
//  Rollback حسابات Auth التي أنشأها الإصلاح — عبر Supabase Auth Admin API.
//  يثبت المشروع والمفتاح بنفس طريقة سكربت الإنشاء.
//  الفحص: DRY_RUN=1. الحذف الفعلي يتطلّب APPLY_AUTH_ROLLBACK=YES_DELETE_REPAIR_USERS.
//  يحذف حساباً فقط عند تطابق كل الحراس وغياب أي رابط مباشر بالمستخدم.
//  لا يطبع سراً/كلمة مرور/بريداً كاملاً/توكناً.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { validateProjectUrl, validateSecretKey, rollbackWriteAllowed, runRollback, sanitizeErrorMessage } from './lib/auth-repair-core.mjs';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

const pu = validateProjectUrl(url);
if (!pu.ok) { console.error('ERROR: ' + pu.reason); process.exit(2); }
const pk = validateSecretKey(secret);
if (!pk.ok) { console.error('ERROR: ' + pk.reason); process.exit(2); }

const gate = rollbackWriteAllowed(process.env);
if (!gate.ok) { console.error('ERROR: ' + gate.reason); process.exit(2); }

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

runRollback({ admin, log: (m) => console.log(m), dryRun: gate.dryRun })
  .then(() => process.exit(0))
  .catch((e) => { console.error('خطأ: ' + sanitizeErrorMessage(e && e.message ? e.message : String(e), { url })); process.exit(1); });
