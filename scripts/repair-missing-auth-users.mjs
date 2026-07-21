#!/usr/bin/env node
// =====================================================================
//  إصلاح حسابات Auth الناقصة عبر Supabase Auth Admin API (خادميّ فقط).
//  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng).
//  الأهداف: 392 / 5552 / 2306 فقط. لا يعمل في المتصفح.
//  المفاتيح من البيئة فقط (SUPABASE_URL, SUPABASE_SECRET_KEY). DRY_RUN=1 للفحص.
//  لا يطبع سراً/كلمة مرور/بريداً كاملاً/توكناً؛ السجل: الاسم والرقم والوردية والحالة.
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { validateProjectUrl, validateSecretKey, runRepair } from './lib/auth-repair-core.mjs';

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

runRepair({ admin, log: (m) => console.log(m), dryRun: DRY_RUN })
  .then((res) => {
    console.log('الحالة: ' + res.status);
    if (res.status === 'OK' || res.status === 'DRY_RUN') process.exit(0);
    if (res.status === 'PARTIAL_FAILURE') { console.error('PARTIAL_FAILURE — أرقام متأثرة: ' + res.affected.join(',')); process.exit(3); }
    process.exit(1); // BLOCKED / FAILED_ROLLED_BACK
  })
  .catch((e) => { console.error('خطأ: ' + (e && e.message ? e.message : String(e))); process.exit(1); });
