/* ============================================================
   طبقة المزامنة السحابية (Supabase)
   - تسجيل الدخول والحماية (RLS: المسجّلون فقط)
   - تحميل البيانات ومزامنتها لحظياً بين الأجهزة
   - طابور محلي (Outbox) لحفظ التعديلات دون إنترنت ثم إرسالها عند العودة
   ============================================================ */
'use strict';

const CACHE_KEY = 'shiftApp.cache.v2';
const OUTBOX_KEY = 'shiftApp.outbox.v1';

/* تحويل بين صيغة الواجهة وصيغة قاعدة البيانات */
function empToRow(e){ return { id:e.id, name:e.name, emp_no:e.no||'', cycle_start:e.cycleStart, sort_order:e.sort||0 }; }
function rowToEmp(r){ return { id:r.id, name:r.name, no:r.emp_no||'', cycleStart:r.cycle_start, sort:r.sort_order||0 }; }
function leaveToRow(l){ return { id:l.id, emp_id:l.empId, type:l.type, from_date:l.from, to_date:l.to, status:l.status, notes:l.notes||'' }; }
function rowToLeave(r){ return { id:r.id, empId:r.emp_id, type:r.type, from:r.from_date, to:r.to_date, status:r.status, notes:r.notes||'' }; }

function saveCache(){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify(state)); }catch(e){}
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
    const raw = localStorage.getItem(CACHE_KEY);
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
    window.addEventListener('online',  ()=>{ this.online=true;  updateSyncBadge(); this.flush().then(()=>pullAndRender()); });
    window.addEventListener('offline', ()=>{ this.online=false; updateSyncBadge(); });
  },

  async getSession(){ const { data } = await this.sb.auth.getSession(); return data.session; },
  async currentEmail(){ const { data } = await this.sb.auth.getUser(); return data.user ? data.user.email : ''; },
  async signIn(email, pw){ return await this.sb.auth.signInWithPassword({ email, password: pw }); },
  async signOut(){ await this.sb.auth.signOut(); },
  async changePassword(pw){ return await this.sb.auth.updateUser({ password: pw }); },

  /* تحميل كل البيانات من السحابة إلى الحالة */
  async pull(){
    const [e,l,o,s] = await Promise.all([
      this.sb.from('employees').select('*').order('sort_order'),
      this.sb.from('leaves').select('*'),
      this.sb.from('overrides').select('*'),
      this.sb.from('settings').select('data').eq('id',1).maybeSingle()
    ]);
    const err = e.error || l.error || o.error || s.error;
    if(err) throw err;
    state.employees = (e.data||[]).map(rowToEmp);
    state.leaves    = (l.data||[]).map(rowToLeave);
    state.overrides = {};
    (o.data||[]).forEach(r=>{ (state.overrides[r.emp_id] = state.overrides[r.emp_id] || {})[r.day] = r.value; });
    state.settings  = mergeSettings(s.data && s.data.data);
    saveCache();
  },

  /* الاشتراك في التغييرات اللحظية من الأجهزة الأخرى */
  subscribe(cb){
    this.sb.channel('shift-sync')
      .on('postgres_changes', { event:'*', schema:'public' }, ()=>{ cb && cb(); })
      .subscribe();
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
    else if(op.t==='set')    r=await sb.from('settings').upsert({ id:1, data:op.data });
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
  setOverride(empId, day, value){ Cloud.enqueue({ t:'ov_up', row:{ emp_id:empId, day, value } }); saveCache(); },
  delOverride(empId, day){ Cloud.enqueue({ t:'ov_del', emp_id:empId, day }); saveCache(); },
  saveSettings(){ Cloud.enqueue({ t:'set', data: state.settings }); saveCache(); }
};

function uid(){ return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'x'+Date.now()+Math.round(performance.now()); }
