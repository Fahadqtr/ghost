#!/usr/bin/env node
// =====================================================================
//  إصلاح حسابات Auth الناقصة عبر Supabase Auth Admin API (خادميّ فقط).
//  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng).
//  الأهداف: 392 / 5552 / 2306 فقط. لا يعمل في المتصفح.
//  المفاتيح من البيئة فقط (SUPABASE_URL, SUPABASE_SECRET_KEY).
//  الفحص: DRY_RUN=1. الكتابة الفعلية تتطلّب APPLY_AUTH_REPAIR=YES_CREATE_3_USERS.
//  لا يطبع سراً/كلمة مرور/بريداً كاملاً/توكناً.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { validateProjectUrl, validateSecretKey, repairWriteAllowed, runRepair, sanitizeErrorMessage } from './lib/auth-repair-core.mjs';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

const pu = validateProjectUrl(url);
if (!pu.ok) { console.error('ERROR: ' + pu.reason); process.exit(2); }
const pk = validateSecretKey(secret);
if (!pk.ok) { console.error('ERROR: ' + pk.reason); process.exit(2); }

const gate = repairWriteAllowed(process.env);
if (!gate.ok) { console.error('ERROR: ' + gate.reason); process.exit(2); }

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

runRepair({ admin, log: (m) => console.log(m), dryRun: gate.dryRun })
  .then((res) => {
    console.log('الحالة: ' + res.status);
    if (res.status === 'OK' || res.status === 'DRY_RUN') process.exit(0);
    if (res.status === 'PARTIAL_FAILURE') { console.error('PARTIAL_FAILURE — أرقام متأثرة: ' + res.affected.join(',')); process.exit(3); }
    process.exit(1); // BLOCKED / FAILED_ROLLED_BACK
  })
  .catch((e) => { console.error('خطأ: ' + sanitizeErrorMessage(e && e.message ? e.message : String(e), { url })); process.exit(1); });
