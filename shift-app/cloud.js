/* ============================================================
   طبقة المزامنة السحابية (Supabase)
   - تسجيل الدخول والحماية (RLS: المسجّلون فقط)
   - تحميل البيانات ومزامنتها لحظياً بين الأجهزة
   - طابور محلي (Outbox) لحفظ التعديلات دون إنترنت ثم إرسالها عند العودة
   ============================================================ */
'use strict';

const CACHE_KEY_BASE = 'shiftApp.cache.v2';
const OUTBOX_KEY = 'shiftApp.outbox.v1';
// مفتاح تخزين محلي مفصول حسب هوية المستخدم (auth.uid) — يمنع تسرّب cache حساب لآخر أوفلاين
function cacheKey(){
  const uid = (typeof currentUserId !== 'undefined' && currentUserId) ? currentUserId : 'anon';
  return CACHE_KEY_BASE + '.' + uid;
}

/* تحويل بين صيغة الواجهة وصيغة قاعدة البيانات */
function team(){ return (typeof currentTeam!=='undefined' && currentTeam) ? currentTeam : 'w1'; }
function empToRow(e){ return { id:e.id, name:e.name, emp_no:e.no||'', cycle_start:e.cycleStart, sort_order:e.sort||0, team:team() }; }
function rowToEmp(r){ return { id:r.id, name:r.name, no:r.emp_no||'', cycleStart:r.cycle_start, sort:r.sort_order||0 }; }
function leaveToRow(l){
  const r = { id:l.id, emp_id:l.empId, type:l.type, from_date:l.from, to_date:l.to, status:l.status, notes:l.notes||'', team:team() };
  // حقول تجاوز الرصيد تُرسَل فقط عند تفعيلها (upsert لا يمسّ الأعمدة غير المُرسَلة)
  if(l.balanceOverride){ r.balance_override = true; r.balance_override_reason = l.balanceOverrideReason||''; }
  return r;
}
function rowToLeave(r){ return { id:r.id, empId:r.emp_id, type:r.type, from:r.from_date, to:r.to_date, status:r.status, notes:r.notes||'',
  balanceOverride: !!r.balance_override, balanceOverrideReason: r.balance_override_reason||'',
  rejectReason: r.reject_reason||'', decidedAt: r.decided_at||null, submittedAt: r.submitted_at||null }; }
// أرصدة الإجازات
function policyToRow(p){ return { team: p.team||team(), year:p.year, type:p.type, policy_mode:p.mode,
  entitled_days: (p.entitled===''||p.entitled==null)?null:Number(p.entitled),
  max_carryover: Number(p.maxCarryover||0), day_count_basis: p.basis||'calendar' }; }
function rowToPolicy(r){ return { team:r.team, year:r.year, type:r.type, mode:r.policy_mode,
  entitled: r.entitled_days, maxCarryover: r.max_carryover||0, basis: r.day_count_basis||'calendar' }; }

function saveCache(){
  try{ localStorage.setItem(cacheKey(), JSON.stringify(state)); }catch(e){}
}
// مسح كل cache التطبيق (كل الحسابات) + تصفير بيانات الأرصدة في الذاكرة — يُستدعى عند الخروج/تبديل الحساب
function clearLocalData(){
  try{
    Object.keys(localStorage).forEach(k=>{ if(k.indexOf(CACHE_KEY_BASE)===0) localStorage.removeItem(k); });
    localStorage.removeItem(OUTBOX_KEY);
  }catch(e){}
  try{ state.policies=[]; state.ledger=[]; state.myBalances=[]; }catch(e){}
}

// دمج إعدادات السحابة مع الافتراضية — لضمان وجود القوائم الأساسية دائماً
function mergeSettings(db){
  const def = JSON.parse(JSON.stringify(window.SEED.settings));
  if(!db || typeof db !== 'object') return def;
  const out = Object.assign({}, def, db);
  if(!Array.isArray(out.leaveTypes) || !out.leaveTypes.length) out.leaveTypes = def.leaveTypes;
  if(!Array.isArray(out.statuses)   || !out.statuses.length)   out.statuses   = def.statuses;
  if(!out.shiftTimes || !Object.keys(out.shiftTimes).length)   out.shiftTimes = def.shiftTimes;
  if(!Array.isArray(out.holidays)) out.holidays = def.holidays;
  return out;
}
function loadCache(){
  try{
    const raw = localStorage.getItem(cacheKey());
    if(raw){ state = JSON.parse(raw); return true; }
  }catch(e){}
  return false;
}

const Cloud = {
  sb: null,
  flushing: false,
  online: navigator.onLine,

  init(){
    this.sb = window.supabase.createClient(SHIFT_CONFIG.url, SHIFT_CONFIG.key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    // عند تجديد الرمز أو الدخول: أعد التحميل بالرمز الصالح
    this.sb.auth.onAuthStateChange((event)=>{
      if(event==='TOKEN_REFRESHED' || event==='SIGNED_IN'){
        if(typeof pullAndRender==='function') pullAndRender();
      }
    });
    window.addEventListener('online',  ()=>{ this.online=true;  updateSyncBadge(); this.flush().then(()=>pullAndRender()); });
    window.addEventListener('offline', ()=>{ this.online=false; updateSyncBadge(); });
    // جدّد الجلسة عند عودة التطبيق للواجهة (قد يكون الرمز انتهى)
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState==='visible') this.sb.auth.refreshSession().catch(()=>{});
    });
  },

  /* قائمة كل الورديات (للمالك فقط — تعتمد على صلاحية RLS) */
  async listTeams(){
    const { data, error } = await this.sb.from('settings').select('team,dept,data').order('team');
    if(error) throw error;
    return (data||[]).map(r=>({ team:r.team, dept:r.dept||'d1', name:(r.data && r.data.teamName) || r.team }));
  },
  /* إنشاء وردية جديدة + حساب مشرفها (للمالك فقط) */
  async createTeam(name, adminUser, adminPass, adminName, assistant, dept){
    const args = { p_team_name: name, p_admin_user: adminUser, p_admin_pass: adminPass,
      p_admin_name: adminName, p_assistant: assistant||'' };
    if(dept) args.p_dept = dept;
    return await this.sb.rpc('create_team', args);
  },
  /* بثّ حقول مشتركة لكل الورديات — اسم رئيس القسم أو تعميم (للمالك فقط) */
  async broadcast(patch){ return await this.sb.rpc('owner_broadcast', { p_patch: patch }); },
  /* حذف وردية بكل بياناتها (للمالك فقط) */
  async deleteTeam(code){ return await this.sb.rpc('delete_team', { p_team: code }); },

  /* ===== المنصّة متعدّدة الأقسام (مدير النظام) ===== */
  async listDepartments(){ return await this.sb.from('departments').select('*').order('id'); },
  async bootstrapSuperadmin(user, pass, name){ return await this.sb.rpc('bootstrap_superadmin', { p_user:user, p_pass:pass, p_name:name||'' }); },
  async adminCreateDepartment(name){ return await this.sb.rpc('admin_create_department', { p_dept_name:name }); },
  async adminCreateOwner(dept, user, pass, name){ return await this.sb.rpc('admin_create_owner', { p_dept:dept, p_user:user, p_pass:pass, p_name:name||'' }); },
  async adminListAccounts(){ return await this.sb.rpc('admin_list_accounts'); },
  async adminRenameDepartment(dept, name){ return await this.sb.rpc('admin_rename_department', { p_dept:dept, p_name:name }); },
  async adminDeleteDepartment(dept){ return await this.sb.rpc('admin_delete_department', { p_dept:dept }); },
  async adminResetPassword(user, pass){ return await this.sb.rpc('admin_reset_password', { p_user:user, p_pass:pass }); },
  async adminRenameAccount(user, name){ return await this.sb.rpc('admin_rename_account', { p_user:user, p_name:name||'' }); },
  async adminDeleteAccount(user){ return await this.sb.rpc('admin_delete_account', { p_user:user }); },
  async adminSetOwnerDept(user, dept){ return await this.sb.rpc('admin_set_owner_dept', { p_user:user, p_dept:dept }); },
  async adminSetOwnerPreset(dept, preset){ return await this.sb.rpc('admin_set_owner_preset', { p_dept:dept, p_preset:preset }); },
  async listDeptPresets(){ const { data } = await this.sb.from('settings').select('dept,data');
    const m={}; (data||[]).forEach(r=>{ if(r.dept && m[r.dept]===undefined) m[r.dept]=(r.data&&r.data.ownerPreset)||'oversight'; }); return m; },
  /* ملخّص لوحة مدير النظام — استدعاء واحد آمن (superadmin فقط؛ الخادم يفرض ذلك) */
  async superadminDashboard(){ return await this.sb.rpc('superadmin_dashboard_summary'); },
  /* ===== إدارة الحسابات ورؤساء الأقسام (superadmin فقط؛ الخادم يفرض كل القيود) ===== */
  async superadminListAccounts(){ return await this.sb.rpc('superadmin_list_accounts'); },
  /* تعطيل/تفعيل الحساب عبر Edge Function آمنة (Admin API على الخادم) — لا service-role في العميل.
     نرسل فقط معرّف الهدف والحالة؛ لا نرسل دور المُنفِّذ (الخادم يشتقّه من التوكن). */
  async superadminSetAccountActive(userId, active){
    const { data, error } = await this.sb.functions.invoke('admin-account-status', { body:{ target_user_id:userId, active:!!active } });
    if(error){
      let msg = (error && error.message) || 'تعذّر تنفيذ العملية';
      try{ if(error.context && error.context.json){ const b=await error.context.json(); if(b && (b.detail||b.error)) msg=b.detail||b.error; } }catch(_){}
      return { error:{ message: msg } };
    }
    return { data };
  },
  /* هل الحساب الحالي فعّال؟ (مصدر موثوق من الخادم؛ لا يعتمد على JWT القديم) */
  async currentUserIsActive(){ const { data, error } = await this.sb.rpc('audit_current_user_is_active'); if(error) return true; return data!==false; },
  async superadminUpdateAccountScope(userId, role, team, dept){ return await this.sb.rpc('superadmin_update_account_scope', { p_user_id:userId, p_role:role, p_team:team, p_dept:dept }); },
  async superadminPromoteHead(userId, dept){ return await this.sb.rpc('superadmin_promote_department_head', { p_user_id:userId, p_dept:dept }); },
  async superadminRemoveHead(userId){ return await this.sb.rpc('superadmin_remove_department_head', { p_user_id:userId }); },
  async superadminReplaceHead(oldId, newId, dept){ return await this.sb.rpc('superadmin_replace_department_head', { p_old_user_id:oldId, p_new_user_id:newId, p_dept:dept }); },

  /* ===== المرحلة 3: سجل التدقيق الأمني + التقارير المتقدّمة =====
     كلها RPCs آمنة على الخادم (SECURITY DEFINER): البحث في التدقيق لمدير النظام فقط،
     والتقارير مقيّدة بنطاق الدور من القاعدة الموثوقة (لا من JWT/LocalStorage). */
  async searchAuditLog(opts){
    opts = opts || {};
    return await this.sb.rpc('superadmin_search_audit_log', {
      p_page: opts.page || 1,
      p_page_size: opts.pageSize || 30,
      p_from: opts.from || null,
      p_to: opts.to || null,
      p_action: opts.action || null,
      p_entity: opts.entity || null,
      p_team: opts.team || null,
      p_search: opts.search || null
    });
  },
  async reportsSummary(){ return await this.sb.rpc('admin_reports_summary'); },
  async leaveReport(from, to){ return await this.sb.rpc('admin_leave_report', { p_from: from || null, p_to: to || null }); },
  async balanceReport(year){ return await this.sb.rpc('admin_balance_report', { p_year: year || null }); },
  async activityReport(from, to){ return await this.sb.rpc('admin_activity_report', { p_from: from || null, p_to: to || null }); },

  /* ===== الإفادات المتقدّمة: محادثات + رسائل + مرفقات =====
     الحقول الحسّاسة (الوردية/الدور/المُنشئ/الوقت) تُفرَض بالخادم (triggers + RLS). */
  async reportListThreads(){
    return await this.sb.from('report_threads').select('*').order('last_msg_at', { ascending:false });
  },
  async reportListMessages(threadId){
    const { data:msgs, error } = await this.sb.from('report_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending:true });
    if(error) return { error };
    let files=[]; const ids=(msgs||[]).map(m=>m.id);
    if(ids.length){ const r=await this.sb.from('report_files').select('*').in('message_id', ids); files=r.data||[]; }
    return { data:{ messages:msgs||[], files } };
  },
  // teamCode: للمسؤول اتركه فارغاً (يُفرَض من ورديته)، ولرئيس القسم مرّر الوردية المستهدَفة
  async reportCreateThread({ team:teamCode, subject, body, authorName }){
    const ins = await this.sb.from('report_threads').insert({ team: teamCode||'', subject: subject||null, created_by_name: authorName||null }).select().single();
    if(ins.error) return { error: ins.error };
    const msg = await this.reportAddMessage({ threadId: ins.data.id, body, authorName });
    if(msg.error) return { error: msg.error, data:{ thread: ins.data } };
    return { data:{ thread: ins.data, message: msg.data } };
  },
  async reportAddMessage({ threadId, body, authorName }){
    return await this.sb.from('report_messages').insert({ thread_id: threadId, body: body||'', author_name: authorName||null }).select().single();
  },
  async reportUploadFile({ teamCode, threadId, messageId, file }){
    const clean = String(file && file.name || 'file').replace(/[^\w.\-]+/g,'_').slice(-80);
    const rand = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now()+'-'+Math.round(Math.random()*1e9));
    const path = `${teamCode}/${threadId}/${rand}__${clean}`;
    const up = await this.sb.storage.from('report-files').upload(path, file, { upsert:false, contentType:(file&&file.type)||undefined });
    if(up.error) return { error: up.error };
    return await this.sb.from('report_files').insert({ message_id: messageId, team: teamCode, path, file_name:(file&&file.name)||null, mime_type:(file&&file.type)||null, size_bytes:(file&&file.size)||null }).select().single();
  },
  async reportSignedUrl(path){
    const { data, error } = await this.sb.storage.from('report-files').createSignedUrl(path, 3600);
    return error ? '' : (data && data.signedUrl) || '';
  },
  async reportSetStatus(threadId, status){
    return await this.sb.from('report_threads').update({ status }).eq('id', threadId);
  },
  async reportDeleteThread(threadId){
    return await this.sb.from('report_threads').delete().eq('id', threadId);
  },

  async getSession(){ const { data } = await this.sb.auth.getSession(); return data.session; },
  async currentEmail(){ const { data } = await this.sb.auth.getUser(); return data.user ? data.user.email : ''; },
  async signIn(email, pw){ return await this.sb.auth.signInWithPassword({ email, password: pw }); },
  async signOut(){ await this.sb.auth.signOut(); },
  async changePassword(pw){ return await this.sb.auth.updateUser({ password: pw }); },

  /* تحميل كل البيانات من السحابة إلى الحالة */
  async pull(){
    const t = team();
    const [e,l,o,s,p] = await Promise.all([
      this.sb.from('employees').select('*').eq('team',t).order('sort_order'),
      this.sb.from('leaves').select('*').eq('team',t),
      this.sb.from('overrides').select('*').eq('team',t),
      this.sb.from('settings').select('data').eq('team',t).maybeSingle(),
      this.sb.from('point_shifts').select('*').eq('team',t)
    ]);
    const err = e.error || l.error || o.error || s.error || p.error;
    if(err) throw err;
    state.employees = (e.data||[]).map(rowToEmp);
    state.leaves    = (l.data||[]).map(rowToLeave);
    state.overrides = {};
    (o.data||[]).forEach(r=>{ (state.overrides[r.emp_id] = state.overrides[r.emp_id] || {})[r.day] = r.value; });
    state.settings  = mergeSettings(s.data && s.data.data);
    state.pointShifts = {};
    (p.data||[]).forEach(r=>{ state.pointShifts[r.day+'|'+r.shift] = { empOrder: r.emp_order||[], approved: !!r.approved, pointName: r.point_name||'النقطة الأمنية', approvedBy: r.approved_by||'', approvedTitle: r.approved_title||'' }; });
    saveCache();
    // أرصدة الإجازات (معزولة: أي خطأ لا يُعطّل المزامنة الأساسية)
    try{ await this.pullBalances(); }catch(e){ /* تُعرض «يتطلب اتصالاً» عند الحاجة */ }
  },

  /* تحميل بيانات الرصيد:
     - owner/admin: يقرؤون leave_policies + leave_ledger لورديتهم (RLS يسمح).
     - viewer: عبر RPC my_leave_balances فقط (لا وصول مباشر للـledger). */
  async pullBalances(){
    const t = team();
    const viewer = (typeof isViewer!=='undefined') ? isViewer : true;
    if(viewer){
      const y = (typeof balanceYear!=='undefined' && balanceYear) ? balanceYear : (new Date().getFullYear());
      const { data, error } = await this.sb.rpc('my_leave_balances', { p_year: y });
      if(error) throw error;
      state.myBalances = data||[];
      state.policies = []; state.ledger = [];
    } else {
      const [pol, led] = await Promise.all([
        this.sb.from('leave_policies').select('*').eq('team',t),
        this.sb.from('leave_ledger').select('*').eq('team',t)
      ]);
      if(pol.error) throw pol.error; if(led.error) throw led.error;
      state.policies = (pol.data||[]).map(rowToPolicy);
      state.ledger   = led.data||[];
      state.myBalances = [];
    }
    saveCache();
  },

  /* قراءة سجل التعديلات (مستقلة تماماً: لا تدخل الطابور، وأي خطأ لا يؤثّر على المزامنة)
     - owner: يمرّر team اختيارياً (فارغ = كل الورديات)
     - admin: يُتجاهل team ويُقصَر تلقائياً على ورديته عبر RLS */
  async fetchAudit(opts){
    opts = opts || {};
    try{
      let q = this.sb.from('audit_log').select('*')
        .order('id', { ascending: false })
        .limit(Math.min(Math.max(opts.limit || 30, 1), 100));
      if(opts.team)   q = q.eq('team', opts.team);
      if(opts.action) q = q.eq('action', opts.action);
      if(opts.entity) q = q.eq('entity', opts.entity);
      if(opts.actor)  q = q.ilike('actor_name', '%' + opts.actor + '%');
      if(opts.from)   q = q.gte('at', opts.from);
      if(opts.to)     q = q.lte('at', opts.to);
      if(opts.before) q = q.lt('id', opts.before);
      const { data, error } = await q;
      if(error) return { rows: [], error: error.message || 'error' };
      return { rows: data || [] };
    }catch(e){
      return { rows: [], error: (e && e.message) || String(e) };
    }
  },

  /* الاشتراك في التغييرات اللحظية من الأجهزة الأخرى */
  subscribe(cb){
    this.sb.channel('shift-sync')
      .on('postgres_changes', { event:'*', schema:'public' }, ()=>{ cb && cb(); })
      .subscribe();
  },

  /* ===== المرحلة 4: سير الاعتماد + الإشعارات (كلها RPCs آمنة على الخادم) =====
     الهوية تُشتقّ من auth.uid()؛ لا نرسل معرّف موظف/وردية/دور من العميل. */
  // تقديم طلب إجازة (الموظف) — الهوية والوردية من القاعدة الموثوقة
  async submitLeave(type, from, to, notes){
    return await this.sb.rpc('submit_leave_request', { p_type:type, p_from:from, p_to:to, p_notes:notes||'' });
  },
  // قرار (اعتماد/رفض) — قفل الصف على الخادم يمنع القرار المزدوج
  async decideLeave(id, decision, reason, override, overrideReason){
    return await this.sb.rpc('decide_leave_request', {
      p_leave_id:id, p_decision:decision, p_reason:reason||'',
      p_override:!!override, p_override_reason:overrideReason||'' });
  },
  // إشعاراتي (ترقيم آمن، الأحدث أولاً) — المستخدم الحالي فقط
  async listNotifications(page, pageSize){
    return await this.sb.rpc('list_my_notifications', { p_page:page||1, p_page_size:pageSize||20 });
  },
  async unreadCount(){ return await this.sb.rpc('notification_unread_count'); },

  /* ===== المرحلة 5: تعديل/إلغاء طلبات الإجازة + السجل التاريخي ===== */
  async updatePendingLeave(id, type, from, to, notes){
    return await this.sb.rpc('update_pending_leave_request', { p_leave_id:id, p_type:type, p_from:from, p_to:to, p_notes:notes||'' });
  },
  async cancelPendingLeave(id, reason){
    return await this.sb.rpc('cancel_pending_leave_request', { p_leave_id:id, p_reason:reason||'' });
  },
  async requestLeaveCancellation(id, reason){
    return await this.sb.rpc('request_approved_leave_cancellation', { p_leave_id:id, p_reason:reason||'' });
  },
  async decideLeaveCancellation(requestId, decision, reason){
    return await this.sb.rpc('decide_leave_cancellation', { p_request_id:requestId, p_decision:decision, p_reason:reason||'' });
  },
  async leaveTimeline(id){ return await this.sb.rpc('get_leave_timeline', { p_leave_id:id }); },
  async listPendingCancellations(){ return await this.sb.rpc('list_pending_leave_cancellations'); },
  async myCancellationRequests(){ return await this.sb.rpc('list_my_cancellation_requests'); },

  /* ===== المرحلة 6: لوحة التشغيل اليومية (قراءة فقط، مقيّدة خادميًا) ===== */
  async dailyOps(days){ return await this.sb.rpc('get_daily_operations_dashboard', { p_upcoming_days: days||7 }); },
  async listOpsActionItems(page, size){ return await this.sb.rpc('list_daily_action_items', { p_page:page||1, p_page_size:size||50 }); },
  async listOpsToday(page, size){ return await this.sb.rpc('list_today_leaves', { p_page:page||1, p_page_size:size||50 }); },
  async listOpsUpcoming(days, page, size){ return await this.sb.rpc('list_upcoming_leaves', { p_upcoming_days:days||7, p_page:page||1, p_page_size:size||50 }); },
  async listOpsAlerts(page, size){ return await this.sb.rpc('list_operational_alerts', { p_page:page||1, p_page_size:size||50 }); },
  /* المرحلة 7: الحضور والانصراف — كل الوقت والهوية من الخادم (لا معاملات وقت/موظّف) */
  async attCheckIn(){ return await this.sb.rpc('attendance_check_in'); },
  async attCheckOut(){ return await this.sb.rpc('attendance_check_out'); },
  async myAttStatus(){ return await this.sb.rpc('get_my_attendance_status'); },
  async listAttSessions(date, status, page, size){ return await this.sb.rpc('list_attendance_sessions', { p_date:date||null, p_status:status||null, p_page:page||1, p_page_size:size||50 }); },
  async attSummary(date){ return await this.sb.rpc('get_attendance_summary', { p_date:date||null }); },
  async listAttAnomalies(page, size){ return await this.sb.rpc('list_attendance_anomalies', { p_page:page||1, p_page_size:size||50 }); },
  async attTimeline(id){ return await this.sb.rpc('get_attendance_timeline', { p_session_id:id }); },
  async correctAtt(id, ci, co, reason){ return await this.sb.rpc('correct_attendance_session', { p_session_id:id, p_check_in_at:ci, p_check_out_at:co, p_reason:reason }); },
  async voidAtt(id, reason){ return await this.sb.rpc('void_attendance_session', { p_session_id:id, p_reason:reason }); },

  /* المرحلة 8 — جدول العمل المتوقع + سياسة الحضور (كلها RPC؛ لا وصول مباشر) */
  async genSchedule(from, to){ return await this.sb.rpc('generate_work_schedule', { p_from_date:from, p_to_date:to }); },
  async getSchedule(from, to, team, page, size){ return await this.sb.rpc('get_work_schedule', { p_from_date:from||null, p_to_date:to||null, p_team:team||null, p_page:page||1, p_page_size:size||50 }); },
  async updSchedule(empId, date, shiftDefId, isWorking, reason){ return await this.sb.rpc('update_employee_work_schedule', { p_employee_id:empId, p_work_date:date, p_shift_definition_id:shiftDefId||null, p_is_working_day:isWorking, p_reason:reason }); },
  async lockSchedule(from, to, lock){ return await this.sb.rpc('lock_work_schedule', { p_from_date:from, p_to_date:to, p_lock:lock }); },
  async schedTimeline(id){ return await this.sb.rpc('get_schedule_timeline', { p_schedule_id:id }); },
  async listShiftDefs(inc){ return await this.sb.rpc('list_shift_definitions', { p_include_inactive:!!inc }); },
  async upsertShiftDef(code, ar, en, start, end, from){ return await this.sb.rpc('upsert_shift_definition', { p_shift_code:code, p_name_ar:ar, p_name_en:en||null, p_start:start, p_end:end, p_effective_from:from }); },
  async listAttPolicies(inc){ return await this.sb.rpc('list_attendance_policies', { p_include_inactive:!!inc }); },
  async upsertAttPolicy(name, scope, ref, grace, cutoff, early, maxHrs, minStaff, from){ return await this.sb.rpc('upsert_attendance_policy', { p_name:name, p_scope_type:scope, p_scope_ref:ref||null, p_grace:grace, p_absence_cutoff:cutoff, p_early_grace:early, p_max_session_hours:maxHrs, p_min_staff:(minStaff===''||minStaff==null)?null:minStaff, p_effective_from:from }); },
  async attOverviewV2(date){ return await this.sb.rpc('get_attendance_overview_v2', { p_date:date||null }); },
  async markNotifRead(id){ return await this.sb.rpc('mark_notification_read', { p_id:id }); },
  async markAllNotifRead(){ return await this.sb.rpc('mark_all_notifications_read'); },

  /* اشتراك Realtime في إشعارات المستخدم الحالي فقط (مُقيَّد بـ user_id).
     ليس آلية أمان — المصدر الأساسي هو RPC؛ هذا لتحديث الجرس فوراً فقط.
     يعمل فقط إن كان الجدول ضمن نشر Realtime (قد لا يكون قبل تطبيق الترحيل)؛ عند غيابه يبقى polling. */
  subscribeNotifications(uid, cb){
    this.unsubscribeNotifications();
    if(!uid) return;
    try{
      this._notifChan = this.sb.channel('notif-'+uid)
        .on('postgres_changes',
            { event:'*', schema:'public', table:'notifications', filter:'user_id=eq.'+uid },
            ()=>{ cb && cb(); })
        .subscribe();
    }catch(e){ this._notifChan=null; }
  },
  unsubscribeNotifications(){
    if(this._notifChan){ try{ this.sb.removeChannel(this._notifChan); }catch(e){} this._notifChan=null; }
  },

  /* ---- الطابور المحلي (Outbox) ---- */
  queue(){ try{ return JSON.parse(localStorage.getItem(OUTBOX_KEY)||'[]'); }catch(e){ return []; } },
  setQueue(q){ localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); updateSyncBadge(); },
  enqueue(op){ const q=this.queue(); q.push(op); this.setQueue(q); this.flush(); },
  pending(){ return this.queue().length; },

  async apply(op){
    const sb=this.sb; let r;
    if(op.t==='emp_up')      r=await sb.from('employees').upsert(op.row);
    else if(op.t==='emp_del')r=await sb.from('employees').delete().eq('id',op.id);
    else if(op.t==='lv_up')  r=await sb.from('leaves').upsert(op.row);
    else if(op.t==='lv_del') r=await sb.from('leaves').delete().eq('id',op.id);
    else if(op.t==='ov_up')  r=await sb.from('overrides').upsert(op.row, { onConflict:'emp_id,day' });
    else if(op.t==='ov_del') r=await sb.from('overrides').delete().eq('emp_id',op.emp_id).eq('day',op.day);
    else if(op.t==='set')    r=await sb.from('settings').upsert({ team:op.team||team(), data:op.data }, { onConflict:'team' });
    else if(op.t==='ps_up')  r=await sb.from('point_shifts').upsert(op.row, { onConflict:'team,day,shift' });
    else if(op.t==='pol_up') r=await sb.from('leave_policies').upsert(op.row, { onConflict:'team,year,type' });
    else if(op.t==='led_add'){
      r=await sb.from('leave_ledger').insert(op.row);
      // idempotency: إعادة إرسال نفس العملية (نفس id) لا تُنشئ قيداً ثانياً.
      if(r && r.error && r.error.code==='23505'){
        const chk=await sb.from('leave_ledger').select('emp_id,year,type,kind,days,source_year').eq('id',op.row.id).maybeSingle();
        const d=chk.data;
        if(d && d.emp_id===op.row.emp_id && Number(d.year)===Number(op.row.year) && d.type===op.row.type
           && d.kind===op.row.kind && Number(d.days)===Number(op.row.days)
           && Number(d.source_year||0)===Number(op.row.source_year||0)){
          r={ error:null };                         // نفس id ونفس البيانات ⇒ نجاح idempotent
        } else {
          console.warn('led_add conflict: same id, different data — dropping', op.row.id);
          r={ error:null };                         // نفس id ببيانات مختلفة ⇒ تعارض؛ يُسقَط ولا يُعاد للأبد
        }
      }
    }
    return r && r.error;
  },

  /* إرسال ما في الطابور بالترتيب؛ يتوقّف عند أول خطأ (غالباً انقطاع الشبكة) */
  async flush(){
    if(this.flushing) return;
    const sess = await this.getSession(); if(!sess) return;
    this.flushing = true;
    try{
      let q = this.queue();
      while(q.length){
        const err = await this.apply(q[0]);
        if(err){ console.warn('sync paused:', err.message||err); break; }
        q.shift(); this.setQueue(q);
      }
    }catch(e){ /* الشبكة */ }
    finally{ this.flushing=false; updateSyncBadge(); }
  }
};

/* دوال تُستدعى من الواجهة: تحدّث الحالة محلياً فوراً + تضيف للطابور */
const Data = {
  upsertEmp(e){ Cloud.enqueue({ t:'emp_up', row: empToRow(e) }); saveCache(); },
  delEmp(id){ Cloud.enqueue({ t:'emp_del', id }); saveCache(); },
  upsertLeave(l){ Cloud.enqueue({ t:'lv_up', row: leaveToRow(l) }); saveCache(); },
  delLeave(id){ Cloud.enqueue({ t:'lv_del', id }); saveCache(); },
  // أرصدة الإجازات
  savePolicy(p){ Cloud.enqueue({ t:'pol_up', row: policyToRow(p) }); saveCache(); },
  addLedger(entry){ Cloud.enqueue({ t:'led_add', row: {
    id: entry.id,                                  // مفتاح idempotency يولّده العميل مرّة واحدة
    emp_id: entry.empId, year: Number(entry.year),
    type: entry.type, kind: entry.kind, days: Number(entry.days),
    source_year: entry.sourceYear!=null ? Number(entry.sourceYear) : null,
    reason: entry.reason||'' } }); saveCache(); },
    // ملاحظة: team/created_by/created_at لا تُرسَل — يفرضها الخادم (trg_ledger_server).
  setOverride(empId, day, value){ Cloud.enqueue({ t:'ov_up', row:{ emp_id:empId, day, value, team:team() } }); saveCache(); },
  delOverride(empId, day){ Cloud.enqueue({ t:'ov_del', emp_id:empId, day }); saveCache(); },
  saveSettings(){ Cloud.enqueue({ t:'set', data: state.settings, team:team() }); saveCache(); },
  savePointShift(day, shift, ps){
    (state.pointShifts = state.pointShifts || {})[day+'|'+shift] = ps;
    Cloud.enqueue({ t:'ps_up', row:{ day, shift, team:team(), point_name: ps.pointName||'النقطة الأمنية', emp_order: ps.empOrder||[], approved: !!ps.approved, approved_by: ps.approvedBy||'', approved_title: ps.approvedTitle||'' } });
    saveCache();
  }
};

function uid(){ return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'x'+Date.now()+Math.round(performance.now()); }
