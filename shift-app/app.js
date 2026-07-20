/* ============================================================
   تطبيق إدارة الورديات — قسم العمليات الجمركية (نسخة سحابية متزامنة)
   البيانات مشتركة بين كل الأجهزة عبر Supabase، وتُحفظ نسخة محلية للعمل دون إنترنت.
   ============================================================ */
'use strict';

const WORK_SHIFTS = ['صباح', 'عصر', 'ليل'];
const REST = 'راحة';
const AR_DAYS = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const RED = 'C00000'; // لون الملاحظات/العنوان الأحمر في الكشف
// قيم افتراضية لترويسة الكشف (قابلة للتعديل من الإعدادات)
function docLocation(){ return (state.settings.location||'جمارك مطار حمد الدولي'); }
function docTeam(){ return (state.settings.teamName||'الوردية الأولى'); }
function docSupervisor(){ return (state.settings.supervisor||''); }

/* الحالة الابتدائية (تُملأ من السحابة بعد الدخول) */
let state = { employees: [], leaves: [], overrides: {}, settings: JSON.parse(JSON.stringify(window.SEED.settings)) };
let currentUserEmail = '';
let currentEmpNo = '';  // الرقم الوظيفي للموظف المسجّل (لدور العرض)
let isViewer = false;   // موظف: عرض فقط (جدول + كشف يومي)
let highlightDate = null; // تاريخ يُبرَز في الجدول (زر أقرب وردية)

/* -------------------- أدوات التاريخ -------------------- */
function toISO(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parseISO(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function today(){ const n=new Date(); return new Date(n.getFullYear(),n.getMonth(),n.getDate()); }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function daysBetween(a,b){ return Math.round((parseISO(b)-parseISO(a))/86400000); }
function fmtDate(iso){ const d=parseISO(iso); return d.getDate()+' '+AR_MONTHS[d.getMonth()]+' '+d.getFullYear(); }
function fmtSlash(iso){ const d=parseISO(iso); return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0'); }
function inclusiveDays(from,to){ return daysBetween(from,to)+1; }

/* -------------------- منطق الورديات -------------------- */
function shiftPattern(){
  const s=state.settings, start=WORK_SHIFTS.indexOf(s.startShift), pat=[];
  for(let i=0;i<s.workDays;i++){ pat.push(WORK_SHIFTS[(start+Math.floor(i/2))%3]); }
  return pat;
}
function rotationShift(emp, iso){
  const s=state.settings, startISO=emp.cycleStart||s.scheduleStart, diff=daysBetween(startISO,iso);
  if(diff<0) return '';
  const cycle=s.workDays+s.restDays, pos=((diff%cycle)+cycle)%cycle;
  return pos<s.workDays ? shiftPattern()[pos] : REST;
}
// أي إجازة (معتمدة أو قيد الانتظار) تغطّي اليوم — تُفضَّل المعتمدة، وتُستبعد المرفوضة
function leaveOn(empId, iso){
  const covering=state.leaves.filter(l=>l.empId===empId && l.status!=='مرفوض' && iso>=l.from && iso<=l.to);
  if(!covering.length) return null;
  return covering.find(l=>l.status==='معتمد') || covering[0];
}
function cellValue(emp, iso){
  const ov=state.overrides[emp.id];
  if(ov && ov[iso]) return { value: ov[iso], source:'manual' };
  const lv=leaveOn(emp.id, iso);
  if(lv) return { value: lv.type, source:'leave', pending: lv.status!=='معتمد' };
  return { value: rotationShift(emp,iso), source:'auto' };
}
function isLeaveValue(v){ return state.settings.leaveTypes.includes(v); }
function classFor(v){
  if(v==='') return 'd-empty';
  if(WORK_SHIFTS.includes(v)) return 'd-'+v;
  if(v===REST) return 'd-راحة';
  return 'd-leave';
}
function dayStats(iso){
  const counts={صباح:0,عصر:0,ليل:0,راحة:0,leave:0}; let working=0, onLeave=0;
  state.employees.forEach(e=>{
    const v=cellValue(e,iso).value;
    if(v==='') return;
    if(WORK_SHIFTS.includes(v)){ counts[v]++; working++; }
    else if(v===REST){ counts.راحة++; }
    else { counts.leave++; onLeave++; }
  });
  return {counts, working, onLeave};
}

/* -------------------- التنقّل -------------------- */
const screens=['dash','emps','sched','leaves','daily'];
let current='dash';
function nav(to){
  current=to;
  screens.forEach(s=>document.getElementById('scr-'+s).classList.toggle('active', s===to));
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active', b.dataset.nav===to));
  document.getElementById('fab').style.display = (to==='emps'||to==='leaves') ? 'grid' : 'none';
  window.scrollTo(0,0);
  renderScreen(to);
}
function renderScreen(to){
  if(to==='dash') renderDash();
  else if(to==='emps') renderEmps();
  else if(to==='sched') renderSched();
  else if(to==='leaves') renderLeaves();
  else if(to==='daily') renderDaily();
}

/* -------------------- لوحة المعلومات -------------------- */
/* -------- رابط ورمز QR لدخول الموظفين -------- */
function staffUrl(){ return location.origin + location.pathname + '?staff'; }
function copyStaffLink(){
  const u=staffUrl();
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(u).then(()=>toast('تم نسخ الرابط')).catch(()=>toast(u)); }
  else toast(u);
}
// يولّد صورة PNG (data URL) لرمز QR محلياً بدون إنترنت
function staffQrDataUrl(scale){
  try{
    const cv=document.createElement('canvas');
    window.QR.draw(cv, staffUrl(), {scale:scale||8, margin:4});
    return cv.toDataURL('image/png');
  }catch(e){ return ''; }
}
function showStaffQR(){
  const u=staffUrl(), png=staffQrDataUrl(8);
  openSheet(`
    <h3>رمز دخول الموظفين<button class="x" onclick="closeSheet()">×</button></h3>
    <div style="text-align:center">
      ${png?`<img src="${png}" alt="QR" style="width:250px;height:250px;max-width:100%;image-rendering:pixelated;border:1px solid var(--line);border-radius:12px;padding:8px;background:#fff">`
           :'<div style="color:var(--muted);font-size:13px">تعذّر توليد الرمز — استخدم الرابط بالأسفل.</div>'}
      <p class="meta" style="margin-top:10px">يمسح الموظف الرمز بكاميرا الجوال ← تفتح صفحة الدخول ← يُدخل رقمه الوظيفي.</p>
      <div style="direction:ltr;font-size:12px;word-break:break-all;background:var(--bg);border-radius:8px;padding:8px;margin-top:8px">${u}</div>
    </div>
    <button class="btn block" style="margin-top:12px" onclick="copyStaffLink()">🔗 نسخ الرابط</button>
    <button class="btn block ghost" style="margin-top:8px" onclick="printStaffCard()">🖨️ طباعة البطاقة</button>
  `);
}
function printStaffCard(){
  const u=staffUrl(), png=staffQrDataUrl(10);
  const html=`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>دخول الموظفين</title>
    <style>body{font-family:'Segoe UI',Tahoma,sans-serif;text-align:center;padding:40px;color:#111}
    h1{color:#8A1538;font-size:22px;margin-bottom:4px} p{font-size:15px} img{width:320px;height:320px;image-rendering:pixelated;margin:18px auto;display:block}
    .u{direction:ltr;font-size:13px;word-break:break-all;color:#444}</style></head>
    <body><h1>دخول الموظفين — عرض الورديات</h1>
    <p>امسح الرمز بكاميرا الجوال ثم أدخل رقمك الوظيفي</p>
    ${png?`<img src="${png}" alt="QR">`:''}
    <p class="u">${u}</p></body></html>`;
  const f=document.createElement('iframe');
  f.style.position='fixed'; f.style.right='-9999px'; f.style.bottom='0'; f.style.width='0'; f.style.height='0'; f.style.border='0';
  document.body.appendChild(f);
  const d=f.contentWindow.document; d.open(); d.write(html); d.close();
  setTimeout(()=>{ try{ f.contentWindow.focus(); f.contentWindow.print(); }catch(e){} setTimeout(()=>{ try{ f.remove(); }catch(e){} },1500); }, 250);
}
function renderDash(){
  const iso=toISO(today()), st=dayStats(iso), s=state.settings, low=st.working<s.minWorkers;
  const el=document.getElementById('scr-dash');
  const soon=state.leaves.filter(l=>l.status==='معتمد' && daysBetween(iso,l.from)>=0 && daysBetween(iso,l.from)<=7);
  const perEmp={}; state.employees.forEach(e=>perEmp[e.id]=0);
  state.leaves.filter(l=>l.status==='معتمد').forEach(l=>{ if(perEmp[l.empId]!=null) perEmp[l.empId]+=inclusiveDays(l.from,l.to); });
  const pending=state.leaves.filter(l=>l.status==='قيد الانتظار').length;
  const pendingLeaves=state.leaves.filter(l=>l.status==='قيد الانتظار').sort((a,b)=>a.from<b.from?-1:1);
  el.innerHTML=`
    <div class="card" style="background:linear-gradient(135deg,var(--teal-l),#fff)">
      <div style="font-size:13px;color:var(--muted)">${AR_DAYS[today().getDay()]} — ${fmtDate(iso)}</div>
      <div style="font-weight:800;font-size:18px;margin-top:2px">حالة اليوم</div>
    </div>
    <div class="stats">
      <div class="stat ${low?'bad':''}"><div class="n">${st.working}</div><div class="l">عاملون اليوم${low?' • أقل من الحد ('+s.minWorkers+')':''}</div></div>
      <div class="stat ${st.onLeave>s.maxLeavesPerDay?'warn':''}"><div class="n">${st.onLeave}</div><div class="l">مُجازون اليوم • الحد ${s.maxLeavesPerDay}</div></div>
      <div class="stat"><div class="n">${state.employees.length}</div><div class="l">إجمالي الموظفين</div></div>
      <div class="stat ${pending?'warn':''}"><div class="n">${pending}</div><div class="l">طلبات قيد الانتظار</div></div>
    </div>
    <div class="card">
      <h3>طلبات بانتظار الاعتماد (${pendingLeaves.length})</h3>
      ${pendingLeaves.length? pendingLeaves.map(l=>{
        const e=empById(l.empId);
        return `<div class="row">
          <div class="avatar">${initials(e?e.name:'?')}</div>
          <div class="grow"><div class="name">${e?e.name:'— (محذوف)'}</div><div class="meta">${l.type} • ${fmtDate(l.from)} ← ${fmtDate(l.to)} • ${inclusiveDays(l.from,l.to)} يوم</div></div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="btn sm" onclick="approveLeave('${l.id}')">✓ اعتماد</button>
            <button class="btn sm danger" onclick="rejectLeave('${l.id}')">✗ رفض</button>
          </div>
        </div>`;
      }).join('') : '<div class="empty">لا توجد طلبات معلّقة</div>'}
    </div>
    <div class="card">
      <h3>دخول الموظفين (عرض فقط)</h3>
      <div class="meta" style="margin-bottom:8px">شارك الرابط أو رمز QR مع الموظفين — يدخلون بالرقم الوظيفي ويشاهدون الجدول والكشف فقط.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" onclick="showStaffQR()">📱 عرض رمز QR</button>
        <button class="btn sm ghost" onclick="copyStaffLink()">🔗 نسخ الرابط</button>
      </div>
    </div>
    <div class="card">
      <h3>توزيع ورديات اليوم</h3>
      <div class="row"><span class="badge b-صباح">صباح</span><div class="grow meta">${s.shiftTimes['صباح']}</div><b>${st.counts.صباح}</b></div>
      <div class="row"><span class="badge b-عصر">عصر</span><div class="grow meta">${s.shiftTimes['عصر']}</div><b>${st.counts.عصر}</b></div>
      <div class="row"><span class="badge b-ليل">ليل</span><div class="grow meta">${s.shiftTimes['ليل']}</div><b>${st.counts.ليل}</b></div>
      <div class="row"><span class="badge b-راحة">راحة</span><div class="grow meta">خارج الدوام</div><b>${st.counts.راحة}</b></div>
    </div>
    <div class="card">
      <h3>إجازات تبدأ خلال 7 أيام (${soon.length})</h3>
      ${soon.length? soon.sort((a,b)=>a.from<b.from?-1:1).map(l=>{
        const e=empById(l.empId), after=daysBetween(iso,l.from);
        return `<div class="row"><div class="avatar">${initials(e?e.name:'?')}</div>
          <div class="grow"><div class="name">${e?e.name:'—'}</div><div class="meta">${l.type} • ${fmtDate(l.from)}</div></div>
          <span class="badge b-pending">بعد ${after} يوم</span></div>`;
      }).join('') : '<div class="empty">لا توجد إجازات قريبة</div>'}
    </div>
    <div class="card">
      <h3>عدالة توزيع الإجازات (إجمالي الأيام)</h3>
      ${state.employees.length? state.employees.map(e=>{
        const days=perEmp[e.id]||0, max=Math.max(1,...Object.values(perEmp));
        return `<div style="margin:8px 0">
          <div style="display:flex;justify-content:space-between;font-size:13px"><span>${e.name}</span><b>${days} يوم</b></div>
          <div style="height:8px;background:var(--bg);border-radius:6px;overflow:hidden;margin-top:4px">
            <div style="height:100%;width:${Math.round(days/max*100)}%;background:var(--teal)"></div></div>
        </div>`;
      }).join('') : '<div class="empty">لا يوجد موظفون</div>'}
    </div>`;
}

/* -------------------- الموظفون -------------------- */
function empById(id){ return state.employees.find(e=>e.id===id); }
function initials(name){ const p=(name||'').trim().split(/\s+/); return (p[0]?p[0][0]:'؟')+(p[1]?p[1][0]:''); }

function renderEmps(){
  const el=document.getElementById('scr-emps'), iso=toISO(today());
  el.innerHTML=`<h2 class="title">الموظفون (${state.employees.length})</h2>
    <div class="card" style="padding:6px 12px">
      ${state.employees.length? state.employees.map(e=>{
        const v=cellValue(e,iso).value;
        const badge=v===''?'':`<span class="badge ${isLeaveValue(v)?'b-leave':'b-'+(WORK_SHIFTS.includes(v)?v:'راحة')}">${v||'—'}</span>`;
        return `<div class="row">
          <div class="avatar">${initials(e.name)}</div>
          <div class="grow"><div class="name">${e.name}</div><div class="meta">الرقم الوظيفي: ${e.no} • بداية الدورة: ${fmtDate(e.cycleStart)}</div></div>
          ${badge}
          <button class="icon-btn" onclick="editEmp('${e.id}')" title="تعديل">✏️</button>
          <button class="icon-btn danger" onclick="deleteEmp('${e.id}')" title="شطب">🗑️</button>
        </div>`;
      }).join('') : '<div class="empty">لا يوجد موظفون — أضف موظفاً بزر +</div>'}
    </div>
    <button class="btn block" onclick="editEmp('')">＋ تسجيل موظف جديد</button>`;
}
function editEmp(id){
  const e=id?empById(id):null;
  openSheet(`
    <h3>${e?'تعديل بيانات موظف':'تسجيل موظف جديد'}<button class="x" onclick="closeSheet()">×</button></h3>
    <div class="field"><label>الاسم الكامل</label><input id="f-name" value="${e?esc(e.name):''}" placeholder="مثال: سالم شفيع المري"></div>
    <div class="field"><label>الرقم الوظيفي</label><input id="f-no" inputmode="numeric" value="${e?esc(e.no):''}" placeholder="مثال: 392"></div>
    <div class="field"><label>بداية دورة العمل</label><input id="f-cs" type="date" value="${e?e.cycleStart:state.settings.scheduleStart}">
      <div class="hint">تحدّد بداية دورة الـ${state.settings.workDays} عمل / ${state.settings.restDays} راحة لهذا الموظف.</div></div>
    <button class="btn block" onclick="saveEmp('${id}')">${e?'حفظ التعديلات':'تسجيل الموظف'}</button>
    ${e?`<button class="btn block danger" style="margin-top:8px" onclick="deleteEmp('${id}')">شطب الموظف</button>`:''}
  `);
}
function saveEmp(id){
  const name=val('f-name').trim(), no=val('f-no').trim(), cs=val('f-cs');
  if(!name){ toast('أدخل الاسم'); return; }
  if(!no){ toast('أدخل الرقم الوظيفي'); return; }
  let e;
  if(id){ e=empById(id); if(!e) return; e.name=name; e.no=no; e.cycleStart=cs; }
  else { e={ id:uid(), name, no, cycleStart:cs, sort:(state.employees.reduce((m,x)=>Math.max(m,x.sort||0),0)+1) }; state.employees.push(e); }
  Data.upsertEmp(e); closeSheet(); renderScreen(current); toast(id?'تم الحفظ':'تم تسجيل الموظف');
}
function deleteEmp(id){
  const e=empById(id); if(!e) return;
  if(!confirm(`شطب الموظف «${e.name}»؟\nسيُحذف من الجدول وتُحذف طلبات إجازاته.`)) return;
  state.employees=state.employees.filter(x=>x.id!==id);
  state.leaves=state.leaves.filter(l=>l.empId!==id);
  delete state.overrides[id];
  Data.delEmp(id); closeSheet(); nav('emps'); toast('تم شطب الموظف');
}

/* -------------------- جدول الورديات -------------------- */
let schedMonth=null;
function ensureMonth(){
  if(schedMonth) return;
  const d=parseISO(state.settings.scheduleStart), t=today();
  schedMonth={ y:t.getFullYear(), m:t.getMonth() };
  if(t<d) schedMonth={ y:d.getFullYear(), m:d.getMonth() };
}
function renderSched(){
  ensureMonth();
  const el=document.getElementById('scr-sched'), {y,m}=schedMonth, days=new Date(y,m+1,0).getDate();
  const todayISO=toISO(today());
  let head='';
  for(let d=1;d<=days;d++){
    const iso=toISO(new Date(y,m,d)), wd=new Date(y,m,d).getDay(), wknd=(wd===5||wd===6);
    head+=`<th class="${wknd?'wknd':''} ${wd===5?'fridaycol':''} ${iso===todayISO?'today':''}"><div>${AR_DAYS[wd].slice(0,3)}</div><div style="font-weight:800">${d}</div></th>`;
  }
  const rows=state.employees.map(e=>{
    let tds='';
    for(let d=1;d<=days;d++){
      const iso=toISO(new Date(y,m,d)), cv=cellValue(e,iso);
      const marks=(cv.source==='manual'?'edited ':'')+(cv.pending?'pending ':'')+(iso===todayISO?'today ':'')+(iso===highlightDate?'jump':'');
      tds+=`<td class="daycell ${classFor(cv.value)} ${marks}" onclick="editCell('${e.id}','${iso}')">${labelShort(cv.value)}</td>`;
    }
    return `<tr><td class="namecol">${e.name}<div class="meta" style="font-weight:400;font-size:11px">${e.no}</div></td>${tds}</tr>`;
  }).join('');
  const shiftRows=WORK_SHIFTS.map(sh=>{
    let cells='';
    for(let d=1;d<=days;d++){
      const c=dayStats(toISO(new Date(y,m,d))).counts[sh];
      cells+=`<td class="fcount ${c>0?'f-'+sh:'fzero'} ${toISO(new Date(y,m,d))===todayISO?'today':''}">${c>0?c:'·'}</td>`;
    }
    return `<tr class="shift-row"><td class="namecol"><span class="fdot dot-${sh}"></span>${sh}</td>${cells}</tr>`;
  }).join('');
  let totalCells='';
  for(let d=1;d<=days;d++){
    const iso=toISO(new Date(y,m,d)), w=dayStats(iso).working, low=w<state.settings.minWorkers;
    totalCells+=`<td class="${low?'low':(w>0?'ok':'')} ${iso===todayISO?'today':''}">${w}</td>`;
  }
  el.innerHTML=`
    <div class="sched-bar">
      <button class="btn ghost sm" onclick="moveMonth(1)">‹ التالي</button>
      <div class="m">${AR_MONTHS[m]} ${y}</div>
      <button class="btn ghost sm" onclick="moveMonth(-1)">السابق ›</button>
    </div>
    <div class="sched-actions">
      <button class="btn sm" onclick="goToday()">اليوم</button>
      <button class="btn gold sm" onclick="jumpNearestShift()">⦿ أقرب وردية</button>
    </div>
    <div class="tablewrap">
      <table class="sched">
        <thead><tr><th class="namecol">الاسم</th>${head}</tr></thead>
        <tbody>${rows||''}</tbody>
      </table>
    </div>
    <div class="card summary-card">
      <h3>ملخّص التغطية اليومية</h3>
      <div class="tablewrap">
        <table class="sched">
          <thead><tr><th class="namecol">الوردية</th>${head}</tr></thead>
          <tfoot>${shiftRows}<tr class="total-row"><td class="namecol">إجمالي العاملين</td>${totalCells}</tr></tfoot>
        </table>
      </div>
    </div>
    <div class="leg">
      <span><i style="background:var(--morning-l)"></i>صباح</span>
      <span><i style="background:var(--amber-l)"></i>عصر</span>
      <span><i style="background:var(--indigo-l)"></i>ليل</span>
      <span><i style="background:#fff;border:1px solid var(--line)"></i>راحة</span>
      <span><i style="background:var(--red-l)"></i>إجازة معتمدة</span>
      <span><i style="background:repeating-linear-gradient(45deg,#fff5f6,#fff5f6 2px,#fde8ec 2px,#fde8ec 4px);border:1px dashed #eaa"></i>قيد الانتظار</span>
      <span><i style="background:var(--teal);border-radius:50%"></i>تعديل يدوي</span>
    </div>
    ${isViewer?'<p class="hint">عرض فقط — جدول الورديات.</p>':'<p class="hint">اضغط على أي خانة لتغيير الوردية يدوياً. التعديل اليدوي يتجاوز الدورة والإجازات.</p>'}`;
  // مرّر أفقياً إلى الوردية المُبرَزة أو إلى اليوم
  setTimeout(()=>{
    const t=el.querySelector('.daycell.jump') || el.querySelector('td.today') || el.querySelector('th.today');
    if(t) t.scrollIntoView({inline:'center', block:'nearest'});
  },0);
}
function labelShort(v){
  if(v==='') return '';
  if(v==='صباح') return 'ص'; if(v==='عصر') return 'ع'; if(v==='ليل') return 'ل'; if(v===REST) return '•';
  const map={'سنوية':'سنوية','عارض':'عارض','دورية':'دورية','مرضية':'مرضية','مرافق مريض':'مرافق','غياب':'غياب'};
  return map[v]||v;
}
function moveMonth(dir){ let {y,m}=schedMonth; m+=dir; if(m>11){m=0;y++;} if(m<0){m=11;y--;} schedMonth={y,m}; highlightDate=null; renderSched(); }
function viewerEmp(){ return currentEmpNo ? state.employees.find(e=>e.no===currentEmpNo) : null; }
function goToday(){ const t=today(); schedMonth={y:t.getFullYear(),m:t.getMonth()}; highlightDate=null; renderSched(); }
// أقرب وردية قادمة: للموظف ورديته هو، وللمشرف أقرب يوم عمل للفريق
function jumpNearestShift(){
  const ve=viewerEmp(), start=today(); let target=null, shift='';
  for(let i=0;i<3660;i++){
    const iso=toISO(addDays(start,i));
    if(ve){ const v=cellValue(ve,iso).value; if(WORK_SHIFTS.includes(v)){ target=iso; shift=v; break; } }
    else { const st=dayStats(iso); if(st.working>0){ target=iso; shift=st.counts.صباح?'صباح':(st.counts.عصر?'عصر':'ليل'); break; } }
  }
  if(!target){ toast('لا توجد ورديات قادمة'); return; }
  const d=parseISO(target); schedMonth={y:d.getFullYear(),m:d.getMonth()}; highlightDate=target; renderSched();
  toast('أقرب وردية: '+fmtDate(target)+(shift?' — '+shift:''));
}
function editCell(empId, iso){
  if(isViewer) return;   // الموظف لا يعدّل
  const e=empById(empId); if(!e) return;
  const cur=cellValue(e,iso), auto=rotationShift(e,iso), opts=[...WORK_SHIFTS, REST, ...state.settings.leaveTypes];
  openSheet(`
    <h3>${e.name}<button class="x" onclick="closeSheet()">×</button></h3>
    <div class="hint" style="margin-bottom:12px">${AR_DAYS[parseISO(iso).getDay()]} — ${fmtDate(iso)} • الأصل حسب الدورة: <b>${auto||'—'}</b></div>
    <div class="pick">${opts.map(o=>`<button class="${cur.value===o?'on':''}" onclick="setCell('${empId}','${iso}','${o}')">${o}</button>`).join('')}</div>
    <button class="btn block ghost" style="margin-top:14px" onclick="clearCell('${empId}','${iso}')">↺ إرجاع للأصل (حسب الدورة/الإجازة)</button>
    <div class="hint">${cur.source==='manual'?'هذه الخانة معدّلة يدوياً.':cur.source==='leave'?'هذه الخانة من إجازة معتمدة.':'هذه الخانة محسوبة تلقائياً من الدورة.'}</div>
  `);
}
function setCell(empId, iso, value){
  state.overrides[empId]=state.overrides[empId]||{}; state.overrides[empId][iso]=value;
  Data.setOverride(empId, iso, value); closeSheet(); renderSched(); toast('تم تعديل الوردية');
}
function clearCell(empId, iso){
  if(state.overrides[empId]){ delete state.overrides[empId][iso]; if(!Object.keys(state.overrides[empId]).length) delete state.overrides[empId]; }
  Data.delOverride(empId, iso); closeSheet(); renderSched(); toast('أُرجعت للأصل');
}

/* -------------------- الإجازات -------------------- */
let leaveFilter='الكل';
function renderLeaves(){
  if(isViewer) return renderMyLeaves();
  const el=document.getElementById('scr-leaves'), iso=toISO(today());
  const list=state.leaves.slice().sort((a,b)=>a.from<b.from?1:-1);
  const filtered=leaveFilter==='الكل'?list:list.filter(l=>l.status===leaveFilter);
  el.innerHTML=`<h2 class="title">حجز الإجازات (${state.leaves.length})</h2>
    <div class="seg">${['الكل','معتمد','قيد الانتظار','مرفوض'].map(f=>`<button class="${leaveFilter===f?'on':''}" onclick="setLeaveFilter('${f}')">${f}</button>`).join('')}</div>
    <div class="card" style="padding:6px 12px">
      ${filtered.length? filtered.map(l=>{
        const e=empById(l.empId), days=inclusiveDays(l.from,l.to), active=l.status==='معتمد'&&iso>=l.from&&iso<=l.to, cov=coverageCheck(l);
        return `<div class="row">
          <div class="avatar">${initials(e?e.name:'?')}</div>
          <div class="grow">
            <div class="name">${e?e.name:'— (موظف محذوف)'} ${active?'<span class="badge b-leave" style="margin-inline-start:4px">اليوم</span>':''}</div>
            <div class="meta">${l.type} • ${fmtDate(l.from)} ← ${fmtDate(l.to)} • ${days} يوم</div>
            <div class="meta ${cov.ok?'':'warn'}" style="margin-top:2px">${cov.text}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <span class="badge ${l.status==='معتمد'?'b-ok':l.status==='مرفوض'?'b-rej':'b-pending'}">${l.status}</span>
            <div style="display:flex;gap:6px">
              <button class="icon-btn" onclick="editLeave('${l.id}')">✏️</button>
              <button class="icon-btn danger" onclick="deleteLeave('${l.id}')">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('') : '<div class="empty">لا توجد طلبات في هذا التصنيف</div>'}
    </div>
    <button class="btn block" onclick="editLeave('')">＋ حجز إجازة جديدة</button>`;
}
function setLeaveFilter(f){ leaveFilter=f; renderLeaves(); }

/* ---- طلبات إجازة الموظف (عرض فقط + تقديم طلب) ---- */
function renderMyLeaves(){
  const el=document.getElementById('scr-leaves'), me=viewerEmp();
  const mine = me ? state.leaves.filter(l=>l.empId===me.id).sort((a,b)=>a.from<b.from?1:-1) : [];
  el.innerHTML=`<h2 class="title">طلبات الإجازة</h2>
    ${me?'':'<div class="card"><div class="empty">لم يتم التعرّف على حسابك — أعد الدخول بالرقم الوظيفي</div></div>'}
    <div class="card" style="padding:6px 12px">
      ${mine.length? mine.map(l=>{
        const days=inclusiveDays(l.from,l.to), canCancel=l.status==='قيد الانتظار';
        return `<div class="row">
          <div class="grow">
            <div class="name">${l.type}</div>
            <div class="meta">${fmtDate(l.from)} ← ${fmtDate(l.to)} • ${days} يوم${l.notes?' • '+esc(l.notes):''}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <span class="badge ${l.status==='معتمد'?'b-ok':l.status==='مرفوض'?'b-rej':'b-pending'}">${l.status}</span>
            ${canCancel?`<button class="icon-btn danger" onclick="cancelMyLeave('${l.id}')">🗑️</button>`:''}
          </div>
        </div>`;
      }).join('') : '<div class="empty">لا توجد طلبات — قدّم طلبك من الزر بالأسفل</div>'}
    </div>
    ${me?'<button class="btn block" onclick="requestLeave()">＋ تقديم طلب إجازة</button>':''}`;
}
function requestLeave(){
  const s=state.settings;
  openSheet(`
    <h3>تقديم طلب إجازة<button class="x" onclick="closeSheet()">×</button></h3>
    <div class="field"><label>نوع الإجازة</label>
      <div class="pick">${s.leaveTypes.map(t=>`<button data-t="${t}" class="${s.leaveTypes[0]===t?'on':''}" onclick="pickType(this)">${t}</button>`).join('')}</div></div>
    <div class="two">
      <div class="field"><label>من تاريخ</label><input id="l-from" type="date" value="${toISO(today())}" oninput="updLeaveHint()"></div>
      <div class="field"><label>إلى تاريخ</label><input id="l-to" type="date" value="${toISO(today())}" oninput="updLeaveHint()"></div>
    </div>
    <div class="field"><label>ملاحظات</label><input id="l-notes" placeholder="اختياري"></div>
    <div class="hint" id="l-hint"></div>
    <p class="hint">يُرسَل الطلب إلى المشرف للاعتماد.</p>
    <button class="btn block" style="margin-top:10px" onclick="submitLeaveRequest()">إرسال الطلب</button>
  `);
  sheet._type=s.leaveTypes[0]; updLeaveHint();
}
function submitLeaveRequest(){
  const me=viewerEmp(); if(!me){ toast('تعذّر تحديد حسابك'); return; }
  const from=val('l-from'), to=val('l-to');
  if(!from||!to){ toast('حدد التواريخ'); return; }
  if(to<from){ toast('تاريخ النهاية قبل البداية'); return; }
  const rec={ id:uid(), empId:me.id, type:sheet._type, from, to, status:'قيد الانتظار', notes:val('l-notes').trim() };
  state.leaves.push(rec); Data.upsertLeave(rec);
  closeSheet(); renderScreen(current); toast('تم إرسال الطلب للاعتماد');
}
function cancelMyLeave(id){
  const l=state.leaves.find(x=>x.id===id); if(!l || l.status!=='قيد الانتظار') return;
  if(!confirm('إلغاء طلب الإجازة؟')) return;
  state.leaves=state.leaves.filter(x=>x.id!==id);
  Data.delLeave(id); renderMyLeaves(); toast('تم إلغاء الطلب');
}
function coverageCheck(l){
  if(l.status!=='معتمد') return {ok:true, text:'الطلب '+l.status};
  let worst=0, worstDay=l.from, d=parseISO(l.from), end=parseISO(l.to);
  while(d<=end){ const iso=toISO(d), n=dayStats(iso).onLeave; if(n>worst){worst=n;worstDay=iso;} d=addDays(d,1); }
  const max=state.settings.maxLeavesPerDay, ok=worst<=max;
  return {ok, text: ok?`✓ التغطية سليمة (أقصى ${worst}/${max} مُجازين)`:`⚠ تجاوز التغطية: ${worst}/${max} مُجازين بتاريخ ${fmtDate(worstDay)}`};
}
function editLeave(id){
  const l=id?state.leaves.find(x=>x.id===id):null, s=state.settings;
  const empOpts=state.employees.map(e=>`<option value="${e.id}" ${l&&l.empId===e.id?'selected':''}>${e.name} (${e.no})</option>`).join('');
  openSheet(`
    <h3>${l?'تعديل طلب إجازة':'حجز إجازة جديدة'}<button class="x" onclick="closeSheet()">×</button></h3>
    <div class="field"><label>الموظف</label><select id="l-emp">${empOpts||'<option value="">لا يوجد موظفون</option>'}</select></div>
    <div class="field"><label>نوع الإجازة</label>
      <div class="pick">${s.leaveTypes.map(t=>`<button data-t="${t}" class="${(l?l.type:s.leaveTypes[0])===t?'on':''}" onclick="pickType(this)">${t}</button>`).join('')}</div></div>
    <div class="two">
      <div class="field"><label>من تاريخ</label><input id="l-from" type="date" value="${l?l.from:toISO(today())}" oninput="updLeaveHint()"></div>
      <div class="field"><label>إلى تاريخ</label><input id="l-to" type="date" value="${l?l.to:toISO(today())}" oninput="updLeaveHint()"></div>
    </div>
    <div class="field"><label>الحالة</label>
      <div class="pick">${s.statuses.map(t=>`<button data-t="${t}" class="${(l?l.status:'معتمد')===t?'on':''}" onclick="pickStatus(this)">${t}</button>`).join('')}</div></div>
    <div class="field"><label>ملاحظات</label><input id="l-notes" value="${l?esc(l.notes||''):''}" placeholder="اختياري"></div>
    <div class="hint" id="l-hint"></div>
    <button class="btn block" style="margin-top:10px" onclick="saveLeave('${id}')">${l?'حفظ التعديلات':'حجز الإجازة'}</button>
  `);
  sheet._type=l?l.type:s.leaveTypes[0]; sheet._status=l?l.status:'معتمد'; updLeaveHint();
}
function pickType(btn){ btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('on')); btn.classList.add('on'); sheet._type=btn.dataset.t; updLeaveHint(); }
function pickStatus(btn){ btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('on')); btn.classList.add('on'); sheet._status=btn.dataset.t; updLeaveHint(); }
function updLeaveHint(){
  const from=val('l-from'), to=val('l-to'), h=document.getElementById('l-hint'); if(!h) return;
  if(!from||!to){ h.textContent=''; return; }
  if(to<from){ h.className='hint bad'; h.textContent='⚠ تاريخ النهاية قبل البداية'; return; }
  h.className='hint ok'; h.textContent=`المدة: ${inclusiveDays(from,to)} يوم`;
}
function saveLeave(id){
  const empId=val('l-emp'); if(!empId){ toast('اختر الموظف'); return; }
  const from=val('l-from'), to=val('l-to');
  if(!from||!to){ toast('حدد التواريخ'); return; }
  if(to<from){ toast('تاريخ النهاية قبل البداية'); return; }
  let rec;
  if(id){ rec=state.leaves.find(x=>x.id===id); if(!rec) return; Object.assign(rec,{empId,type:sheet._type,from,to,status:sheet._status,notes:val('l-notes').trim()}); }
  else { rec={ id:uid(), empId, type:sheet._type, from, to, status:sheet._status, notes:val('l-notes').trim() }; state.leaves.push(rec); }
  Data.upsertLeave(rec); closeSheet(); renderScreen(current); toast(id?'تم الحفظ':'تم حجز الإجازة');
}
function deleteLeave(id){
  const l=state.leaves.find(x=>x.id===id); if(!l) return;
  if(!confirm('حذف طلب الإجازة؟')) return;
  state.leaves=state.leaves.filter(x=>x.id!==id);
  Data.delLeave(id); renderLeaves(); toast('تم الحذف');
}
function setLeaveStatus(id, status){
  const l=state.leaves.find(x=>x.id===id); if(!l) return;
  l.status=status; Data.upsertLeave(l); renderScreen(current);
  toast(status==='معتمد'?'✓ تم اعتماد الإجازة':'تم رفض الطلب');
}
function approveLeave(id){ setLeaveStatus(id,'معتمد'); }
function rejectLeave(id){ setLeaveStatus(id,'مرفوض'); }

/* -------------------- كشف يومي -------------------- */
let dailyDate=null;
// ساعات بداية/نهاية الوردية من الإعدادات
function shiftHours(sh){
  const parts=(state.settings.shiftTimes[sh]||'').split('←');
  return { start:(parts[0]||'').trim(), end:(parts[1]||'').trim() };
}
// وردية اليوم (لعرضها في العنوان): أول وردية عمل بين الموظفين، وإلا «راحة»
function dayShiftLabel(iso){
  for(const e of state.employees){ const v=cellValue(e,iso).value; if(WORK_SHIFTS.includes(v)) return v; }
  return REST;
}
// صفوف الكشف: يظهر كل الموظفين مثل النموذج الأصلي.
// العامل: أوقات ورديته والتوقيع باسمه الأول. المُجاز/الراحة: «—» ونوع الإجازة بالأحمر في الملاحظات.
function dailyRows(iso){
  const rows=[];
  state.employees.forEach(e=>{
    const v=cellValue(e,iso).value;
    const fn=String(e.name||'').trim().split(/\s+/)[0]||'';
    if(WORK_SHIFTS.includes(v)){
      const h=shiftHours(v);
      rows.push({ name:e.name, no:e.no, in:h.start, inSig:fn, out:h.end, outSig:fn, note:'', red:false });
    }else if(v===REST || v===''){
      // راحة: بدون أي ملاحظة (كالمداوم) — فقط شرطات في خانات الوقت
      rows.push({ name:e.name, no:e.no, in:'—', inSig:'—', out:'—', outSig:'—', note:'', red:false });
    }else{
      // إجازة فقط: يُكتب نوعها بالأحمر
      rows.push({ name:e.name, no:e.no, in:'—', inSig:'—', out:'—', outSig:'—', note:v, red:true });
    }
  });
  return rows;
}
// جدول الكشف بأنماط مضمّنة (يصلح للعرض والطباعة وملف Word)
function dailyTableHtml(iso){
  const rows=dailyRows(iso);
  const c='border:1px solid #333;padding:9px 5px;text-align:center;font-size:13px';
  const cn='border:1px solid #333;padding:9px 8px;text-align:right;font-size:13px;white-space:nowrap;font-weight:bold';
  const th='border:1px solid #333;padding:9px 5px;text-align:center;font-size:13px;background:#e9edf2;font-weight:bold';
  const cNote='border:1px solid #333;padding:9px 5px;text-align:center;font-size:13px;color:#C00000;font-weight:bold';
  const body=rows.length? rows.map((r,i)=>`<tr>
      <td style="${c}">${i+1}</td><td style="${cn}">${r.name}</td><td style="${c}">${r.no}</td>
      <td style="${c}">${r.in}</td><td style="${c}">${r.inSig}</td>
      <td style="${c}">${r.out}</td><td style="${c}">${r.outSig}</td>
      <td style="${r.red?cNote:c}">${r.note}</td></tr>`).join('')
    : `<tr><td style="${c}" colspan="8">لا يوجد موظفون على رأس العمل</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse" dir="rtl">
    <thead>
      <tr>
        <th style="${th}" rowspan="2">م</th><th style="${th}" rowspan="2">الاسم</th><th style="${th}" rowspan="2">الرقم الوظيفي</th>
        <th style="${th}" colspan="2">الحضور</th><th style="${th}" colspan="2">الانصراف</th><th style="${th}" rowspan="2">ملاحظات</th>
      </tr>
      <tr><th style="${th}">الساعة</th><th style="${th}">التوقيع</th><th style="${th}">الساعة</th><th style="${th}">التوقيع</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}
function dailyDocHtml(iso){
  const s=state.settings, dow=parseISO(iso).getDay(), sup=docSupervisor();
  const box='border:2px solid #333;border-radius:14px;padding:12px 14px;text-align:center;font-family:\'Segoe UI\',Tahoma,sans-serif';
  const title=`<div style="${box};margin-bottom:14px">
      <div style="font-weight:bold;font-size:15px">كشف الحضور والانصراف اليومي / ${esc(docLocation())}</div>
      <div style="font-weight:bold;font-size:15px;color:#C00000;margin-top:6px">${esc(s.department)} / ${esc(docTeam())}${sup?' '+esc(sup):''}</div>
      <div style="font-size:13px;margin-top:8px">اليوم : <b>${AR_DAYS[dow]}</b> &nbsp;&nbsp; التاريخ : ${fmtSlash(iso)} &nbsp;&nbsp; دوام الشفت : ${esc(dayShiftLabel(iso))}</div>
    </div>`;
  const sig=`<div style="display:flex;justify-content:space-between;gap:18px;margin-top:22px;font-family:'Segoe UI',Tahoma,sans-serif">
      <div style="${box};width:44%">
        <div style="font-weight:bold;text-decoration:underline">توقيع مسؤول الوردية</div>
        <div style="margin-top:16px;font-weight:bold">${sup?esc(sup):'&nbsp;'}</div>
      </div>
      <div style="${box};width:44%">
        <div style="font-weight:bold;text-decoration:underline">توقيع رئيس قسم العمليات الجمركية</div>
        <div style="margin-top:16px">&nbsp;</div>
      </div>
    </div>`;
  return `${s.logo?`<div style="text-align:center;margin-bottom:10px"><img src="${s.logo}" style="max-width:100%;max-height:90px"></div>`:''}
    ${title}
    ${dailyTableHtml(iso)}
    ${sig}`;
}
/* ---- مولّد ملف .docx حقيقي (يفتح على الجوال والكمبيوتر) ---- */
function xmlesc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
const _CRC=(()=>{ let t=[]; for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; t[n]=c>>>0; } return t; })();
function crc32(u8){ let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=_CRC[(c^u8[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function zipStore(files){ // files:[{name,data(Uint8Array)}] بدون ضغط
  const te=new TextEncoder(), chunks=[]; let offset=0; const cen=[];
  const b=(n,len)=>{ const a=new Uint8Array(len); let v=n>>>0; for(let i=0;i<len;i++){ a[i]=v&255; v=Math.floor(v/256); } return a; };
  const push=a=>{ chunks.push(a); offset+=a.length; };
  files.forEach(f=>{
    const name=te.encode(f.name), data=f.data, crc=crc32(data), start=offset;
    push(b(0x04034b50,4)); push(b(20,2)); push(b(0,2)); push(b(0,2)); push(b(0,2)); push(b(0x21,2));
    push(b(crc,4)); push(b(data.length,4)); push(b(data.length,4)); push(b(name.length,2)); push(b(0,2));
    push(name); push(data);
    cen.push({name,crc,size:data.length,start});
  });
  const cdStart=offset;
  cen.forEach(c=>{
    push(b(0x02014b50,4)); push(b(20,2)); push(b(20,2)); push(b(0,2)); push(b(0,2)); push(b(0,2)); push(b(0x21,2));
    push(b(c.crc,4)); push(b(c.size,4)); push(b(c.size,4)); push(b(c.name.length,2)); push(b(0,2)); push(b(0,2));
    push(b(0,2)); push(b(0,2)); push(b(0,4)); push(b(c.start,4)); push(c.name);
  });
  const cdSize=offset-cdStart, cdOffset=cdStart;
  push(b(0x06054b50,4)); push(b(0,2)); push(b(0,2)); push(b(cen.length,2)); push(b(cen.length,2));
  push(b(cdSize,4)); push(b(cdOffset,4)); push(b(0,2));
  let total=chunks.reduce((s,a)=>s+a.length,0), out=new Uint8Array(total), p=0;
  chunks.forEach(a=>{ out.set(a,p); p+=a.length; });
  return out;
}
function wTc(text, o){ o=o||{};
  const tcPr='<w:tcPr>'+(o.w?`<w:tcW w:w="${o.w}" w:type="dxa"/>`:'')
    +(o.span?`<w:gridSpan w:val="${o.span}"/>`:'')+(o.vm?`<w:vMerge w:val="${o.vm}"/>`:'')
    +(o.shd?`<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>`:'')+'<w:vAlign w:val="center"/></w:tcPr>';
  const run=(o.vm==='continue')?'':`<w:r><w:rPr><w:rtl/>${o.bold?'<w:b/>':''}${o.color?`<w:color w:val="${o.color}"/>`:''}<w:sz w:val="26"/></w:rPr><w:t xml:space="preserve">${xmlesc(text)}</w:t></w:r>`;
  return `<w:tc>${tcPr}<w:p><w:pPr><w:bidi/><w:jc w:val="${o.align||'center'}"/></w:pPr>${run}</w:p></w:tc>`;
}
// فقرة عنوان/توقيع بخيارات (غامق/تحته خط/لون/حجم/محاذاة)
function wPar(text, o){ o=o||{};
  const rpr=`<w:rPr><w:rtl/>${o.bold?'<w:b/>':''}${o.u?'<w:u w:val="single"/>':''}${o.color?`<w:color w:val="${o.color}"/>`:''}<w:sz w:val="${o.sz||22}"/></w:rPr>`;
  const run=text?`<w:r>${rpr}<w:t xml:space="preserve">${xmlesc(text)}</w:t></w:r>`:'';
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="${o.align||'center'}"/><w:spacing w:after="${o.after==null?60:o.after}"/></w:pPr>${run}</w:p>`;
}
// خلية بإطار (صندوق) تحوي فقرات جاهزة
function wBoxCell(inner, w){
  const bd='<w:tcBorders>'+['top','left','bottom','right'].map(x=>`<w:${x} w:val="single" w:sz="14" w:space="0" w:color="333333"/>`).join('')+'</w:tcBorders>';
  return `<w:tc><w:tcPr>${w?`<w:tcW w:w="${w}" w:type="dxa"/>`:''}${bd}<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;
}
function wGapCell(w){ return `<w:tc><w:tcPr>${w?`<w:tcW w:w="${w}" w:type="dxa"/>`:''}</w:tcPr><w:p/></w:tc>`; }
// يفكّ شعار الإعدادات (data URL) إلى بايتات ويحسب أبعاده بوحدة EMU لملف Word
function logoInfo(){
  const durl=state.settings.logo; if(!durl || typeof durl!=='string') return null;
  const c=durl.indexOf(','); if(c<0) return null;
  let bin; try{ bin=atob(durl.slice(c+1)); }catch(e){ return null; }
  const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  const EMU=9525, maxCx=5486400; // 96dpi، وأقصى عرض ~6 بوصة
  let cx=Math.round((state.settings.logoW||300)*EMU), cy=Math.round((state.settings.logoH||100)*EMU);
  if(cx>maxCx){ cy=Math.round(cy*maxCx/cx); cx=maxCx; }
  if(cx<1||cy<1) return null;
  return { bytes, cx, cy };
}
function dailyDocx(iso){
  const s=state.settings, rows=dailyRows(iso);
  const hd='e9edf2';
  const grid=[500,2450,1200,1150,1150,1150,1150,1638].map(w=>`<w:gridCol w:w="${w}"/>`).join(''); // مجموع 9638 = عرض الصفحة
  const RHh='<w:trPr><w:trHeight w:val="440" w:hRule="atLeast"/></w:trPr>'; // ارتفاع صف الرأس
  const RHb='<w:trPr><w:trHeight w:val="620" w:hRule="atLeast"/></w:trPr>'; // ارتفاع صف البيانات (مسافات أوسع)
  const head1='<w:tr>'+RHh+wTc('م',{vm:'restart',shd:hd,bold:1})+wTc('الاسم',{vm:'restart',shd:hd,bold:1})
    +wTc('الرقم الوظيفي',{vm:'restart',shd:hd,bold:1})+wTc('الحضور',{span:2,shd:hd,bold:1})
    +wTc('الانصراف',{span:2,shd:hd,bold:1})+wTc('ملاحظات',{vm:'restart',shd:hd,bold:1})+'</w:tr>';
  const head2='<w:tr>'+RHh+wTc('',{vm:'continue'})+wTc('',{vm:'continue'})+wTc('',{vm:'continue'})
    +wTc('الساعة',{shd:hd,bold:1})+wTc('التوقيع',{shd:hd,bold:1})+wTc('الساعة',{shd:hd,bold:1})+wTc('التوقيع',{shd:hd,bold:1})
    +wTc('',{vm:'continue'})+'</w:tr>';
  const body=rows.length? rows.map((r,i)=>'<w:tr>'+RHb+wTc(String(i+1))+wTc(r.name,{align:'right',bold:1})+wTc(r.no)
    +wTc(r.in)+wTc(r.inSig)+wTc(r.out)+wTc(r.outSig)+wTc(r.note,{color:r.red?RED:'',bold:r.red?1:0})+'</w:tr>').join('')
    : '<w:tr>'+RHb+wTc('لا يوجد موظفون على رأس العمل',{span:8})+'</w:tr>';
  const border='<w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(x=>`<w:${x} w:val="single" w:sz="6" w:space="0" w:color="333333"/>`).join('')+'</w:tblBorders>';
  const cellMar='<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>';
  const tbl=`<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:jc w:val="center"/><w:bidiVisual/>${border}${cellMar}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${head1}${head2}${body}</w:tbl>`;
  // صندوق العنوان (مطابق للنموذج): سطر أسود، سطر أحمر، ثم اليوم/التاريخ/الشفت
  const dow=parseISO(iso).getDay(), sup=docSupervisor();
  const titleInner = wPar('كشف الحضور والانصراف اليومي / '+docLocation(),{bold:1,sz:26})
    + wPar(s.department+' / '+docTeam()+(sup?' '+sup:''),{bold:1,sz:26,color:RED})
    + wPar('اليوم : '+AR_DAYS[dow]+'      التاريخ : '+fmtSlash(iso)+'      دوام الشفت : '+dayShiftLabel(iso),{sz:22,after:0});
  const titleBox = `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:jc w:val="center"/><w:bidiVisual/></w:tblPr><w:tblGrid><w:gridCol w:w="9638"/></w:tblGrid><w:tr>${wBoxCell(titleInner,9638)}</w:tr></w:tbl>`;
  // صندوقا التوقيع جنباً إلى جنب: مسؤول الوردية (يمين، بالاسم) ورئيس القسم (يسار)
  const supInner = wPar('توقيع مسؤول الوردية',{bold:1,u:1,sz:22,after:280}) + wPar(sup||' ',{bold:1,sz:24,after:120});
  const chiefInner = wPar('توقيع رئيس قسم العمليات الجمركية',{bold:1,u:1,sz:22,after:280}) + wPar(' ',{sz:24,after:120});
  const sigBox = `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:jc w:val="center"/><w:bidiVisual/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="1638"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>${wBoxCell(supInner,4000)}${wGapCell(1638)}${wBoxCell(chiefInner,4000)}</w:tr></w:tbl>`;
  // شعار اختياري: يُضمَّن في رأس الصفحة إن رفعه المستخدم (بدون أي نص تصنيف)
  const logo=logoInfo();
  const logoPara = logo ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${logo.cx}" cy="${logo.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="logo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${logo.cx}" cy="${logo.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` : '';
  const hdr=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">${logoPara||'<w:p/>'}</w:hdr>`;
  const doc=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>`
    +titleBox+'<w:p/>'+tbl+'<w:p/>'+sigBox
    +'<w:sectPr><w:headerReference w:type="default" r:id="rId101"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708"/><w:bidi/></w:sectPr></w:body></w:document>';
  const imgDefaults = logo ? '<Default Extension="png" ContentType="image/png"/>' : '';
  const ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+imgDefaults+'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>';
  const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const drels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>';
  const hrels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>';
  const te=new TextEncoder();
  const files=[
    {name:'[Content_Types].xml', data:te.encode(ct)},
    {name:'_rels/.rels', data:te.encode(rels)},
    {name:'word/_rels/document.xml.rels', data:te.encode(drels)},
    {name:'word/header1.xml', data:te.encode(hdr)},
    {name:'word/document.xml', data:te.encode(doc)}
  ];
  if(logo){
    files.push({name:'word/_rels/header1.xml.rels', data:te.encode(hrels)});
    files.push({name:'word/media/logo.png', data:logo.bytes});
  }
  return zipStore(files);
}
function downloadDailyWord(){
  const iso=dailyDate||toISO(today());
  try{
    const data=dailyDocx(iso);
    const blob=new Blob([data], {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='كشف_يومي_'+iso+'.docx'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    toast('تم تنزيل ملف Word');
  }catch(e){ toast('تعذّر إنشاء الملف'); }
}
function renderDaily(){
  if(!dailyDate) dailyDate=toISO(today());
  const el=document.getElementById('scr-daily'), iso=dailyDate;
  el.innerHTML=`
    <h2 class="title no-print">كشف الحضور اليومي</h2>
    <div class="card no-print"><div class="field" style="margin:0 0 10px"><label>اختر التاريخ</label>
      <input type="date" value="${iso}" onchange="dailyDate=this.value;renderDaily()"></div>
      <button class="btn block" onclick="downloadDailyWord()">⬇️ تحميل ملف Word (وارد)</button>
      <button class="btn block ghost" style="margin-top:8px" onclick="window.print()">🖨️ طباعة / حفظ PDF</button>
    </div>
    <div class="card daily-doc">
      <div class="tablewrap" style="border:none">${dailyDocHtml(iso)}</div>
    </div>`;
}

/* -------------------- الإعدادات -------------------- */
function openSettings(){
  const s=state.settings;
  if(isViewer){
    openSheet(`
      <h3>حسابي<button class="x" onclick="closeSheet()">×</button></h3>
      <div class="hint" style="margin-bottom:12px">مسجّل الدخول: <b>${esc((currentUserEmail||'—'))}</b> — صلاحية عرض فقط</div>
      <button class="btn block ghost" onclick="refreshFromCloud()">↻ تحديث من السحابة</button>
      <button class="btn block danger" style="margin-top:8px" onclick="doLogout()">تسجيل الخروج</button>
    `);
    return;
  }
  openSheet(`
    <h3>الإعدادات<button class="x" onclick="closeSheet()">×</button></h3>
    <div class="field"><label>اسم القسم</label><input id="s-dep" value="${esc(s.department)}"></div>
    <div class="two">
      <div class="field"><label>طول دورة العمل (أيام)</label><input id="s-work" type="number" min="1" value="${s.workDays}"></div>
      <div class="field"><label>طول الراحة (أيام)</label><input id="s-rest" type="number" min="1" value="${s.restDays}"></div>
    </div>
    <div class="two">
      <div class="field"><label>الحد الأدنى للعاملين</label><input id="s-min" type="number" min="0" value="${s.minWorkers}"></div>
      <div class="field"><label>أقصى مُجازين/يوم</label><input id="s-max" type="number" min="0" value="${s.maxLeavesPerDay}"></div>
    </div>
    <div class="field"><label>وردية بداية الفريق</label>
      <div class="pick">${WORK_SHIFTS.map(sh=>`<button data-t="${sh}" class="${s.startShift===sh?'on':''}" onclick="pickStart(this)">${sh}</button>`).join('')}</div></div>
    <div class="field"><label>بداية فترة الجدول</label><input id="s-sched" type="date" value="${s.scheduleStart}"></div>

    <div style="border-top:1px solid var(--line);margin:16px 0 10px"></div>
    <h3 style="font-size:14px">ترويسة الكشف (تظهر في ملف Word)</h3>
    <div class="field"><label>الموقع/الجهة</label><input id="s-loc" value="${esc(docLocation())}" placeholder="جمارك مطار حمد الدولي"></div>
    <div class="two">
      <div class="field"><label>اسم الوردية</label><input id="s-team" value="${esc(docTeam())}" placeholder="الوردية الأولى"></div>
      <div class="field"><label>مسؤول الوردية</label><input id="s-sup" value="${esc(docSupervisor())}" placeholder="اسم المسؤول"></div>
    </div>

    <button class="btn block" onclick="saveSettings()">حفظ الإعدادات</button>
    <button class="btn block ghost" style="margin-top:8px" onclick="refreshFromCloud()">↻ تحديث من السحابة</button>

    <div style="border-top:1px solid var(--line);margin:16px 0 10px"></div>
    <h3 style="font-size:14px">شعار الكشف (يظهر أعلى ملف Word)</h3>
    ${s.logo?`<div style="text-align:center;margin-bottom:8px"><img src="${s.logo}" style="max-width:100%;max-height:80px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff"></div>`:'<p class="hint" style="margin-bottom:8px">لا يوجد شعار — ارفع صورة الشعار الرسمي (QATAR CUSTOMS).</p>'}
    <input id="s-logo" type="file" accept="image/*" style="display:none" onchange="pickLogo(this)">
    <button class="btn block ghost" onclick="document.getElementById('s-logo').click()">📷 ${s.logo?'تغيير الشعار':'رفع شعار'}</button>
    ${s.logo?'<button class="btn block danger" style="margin-top:8px" onclick="removeLogo()">حذف الشعار</button>':''}
    <p class="hint" style="margin-top:6px">يُخزّن في حسابك السحابي الخاص ويتزامن بين أجهزتك — لا يُحفظ في المستودع العام.</p>

    <div style="border-top:1px solid var(--line);margin:16px 0 10px"></div>
    <h3 style="font-size:14px">الحساب</h3>
    <div class="hint" style="margin-bottom:10px">مسجّل الدخول: <b>${esc((currentUserEmail||'—').replace('@shift.local',''))}</b></div>
    <div class="field"><label>تغيير كلمة المرور</label><input id="s-pw" type="password" placeholder="كلمة مرور جديدة (6 أحرف فأكثر)"></div>
    <button class="btn block ghost" onclick="doChangePassword()">تحديث كلمة المرور</button>
    <button class="btn block danger" style="margin-top:8px" onclick="doLogout()">تسجيل الخروج</button>
    <p class="hint" style="text-align:center;margin-top:12px">البيانات مشتركة بين كل الأجهزة عبر حسابك، وتُحفظ نسخة محلية للعمل دون إنترنت.</p>
  `);
  sheet._start=s.startShift;
}
function pickStart(btn){ btn.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('on')); btn.classList.add('on'); sheet._start=btn.dataset.t; }
function saveSettings(){
  const s=state.settings;
  s.department=val('s-dep').trim()||s.department;
  s.workDays=Math.max(1,Number(val('s-work'))||s.workDays);
  s.restDays=Math.max(1,Number(val('s-rest'))||s.restDays);
  s.minWorkers=Math.max(0,Number(val('s-min')));
  s.maxLeavesPerDay=Math.max(0,Number(val('s-max')));
  s.startShift=sheet._start||s.startShift;
  s.scheduleStart=val('s-sched')||s.scheduleStart;
  s.location=val('s-loc').trim();
  s.teamName=val('s-team').trim();
  s.supervisor=val('s-sup').trim();
  Data.saveSettings(); closeSheet(); document.getElementById('hSub').textContent=s.department; renderScreen(current); toast('تم حفظ الإعدادات');
}
/* رفع شعار الكشف: يُصغَّر ويُخزَّن كـ data URL في الإعدادات (سحابة المستخدم الخاصة) */
function pickLogo(input){
  const f=input.files&&input.files[0]; if(!f){ return; }
  const rd=new FileReader();
  rd.onload=()=>{
    const img=new Image();
    img.onload=()=>{
      const maxW=700, scale=Math.min(1, maxW/img.naturalWidth);
      const w=Math.max(1,Math.round(img.naturalWidth*scale)), h=Math.max(1,Math.round(img.naturalHeight*scale));
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      state.settings.logo=cv.toDataURL('image/png');
      state.settings.logoW=w; state.settings.logoH=h;
      Data.saveSettings(); toast('تم حفظ الشعار'); openSettings();
    };
    img.onerror=()=>toast('تعذّر قراءة الصورة');
    img.src=rd.result;
  };
  rd.readAsDataURL(f);
}
function removeLogo(){
  delete state.settings.logo; delete state.settings.logoW; delete state.settings.logoH;
  Data.saveSettings(); toast('تم حذف الشعار'); openSettings();
}
async function refreshFromCloud(){
  closeSheet(); toast('جارٍ التحديث…');
  try{ await Cloud.pull(); document.getElementById('hSub').textContent=state.settings.department; renderScreen(current); toast('تم التحديث'); }
  catch(e){ toast('تعذّر الاتصال'); }
}
async function doChangePassword(){
  const pw=val('s-pw'); if(!pw||pw.length<6){ toast('كلمة المرور 6 أحرف على الأقل'); return; }
  const { error }=await Cloud.changePassword(pw);
  toast(error?'تعذّر التغيير':'تم تغيير كلمة المرور');
}
async function doLogout(){ closeSheet(); await Cloud.signOut(); location.reload(); }

/* -------------------- أدوات واجهة -------------------- */
const sheet=document.getElementById('sheet');
const overlay=document.getElementById('overlay');
function openSheet(html){ sheet.innerHTML=html; overlay.classList.add('open'); }
function closeSheet(){ overlay.classList.remove('open'); }
overlay.addEventListener('click', e=>{ if(e.target===overlay) closeSheet(); });
function val(id){ const el=document.getElementById(id); return el?el.value:''; }
function esc(s){ return String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
let toastT;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1800); }
function updateSyncBadge(){
  const el=document.getElementById('syncBadge'); if(!el) return;
  const p=Cloud.pending?Cloud.pending():0;
  if(!Cloud.online){ el.textContent='غير متصل'+(p?' • '+p:''); el.className='sync off'; }
  else if(p){ el.textContent='مزامنة… '+p; el.className='sync pend'; }
  else { el.textContent='متزامن'; el.className='sync ok'; }
}

/* -------------------- المزامنة اللحظية -------------------- */
let remoteT;
function onRemoteChange(){ clearTimeout(remoteT); remoteT=setTimeout(()=>pullAndRender(), 400); }
function pullAndRender(){ Cloud.pull().then(()=>{ document.getElementById('hSub').textContent=state.settings.department; renderScreen(current); }).catch(()=>{}); }

/* -------------------- الدخول والتشغيل -------------------- */
function showLogin(){ document.getElementById('login').classList.add('open'); }
function hideLogin(){ document.getElementById('login').classList.remove('open'); }
function showEmpLogin(){ document.getElementById('login-admin').style.display='none'; document.getElementById('login-emp').style.display=''; }
function showAdminLogin(){ document.getElementById('login-emp').style.display='none'; document.getElementById('login-admin').style.display=''; }
async function doEmpLogin(){
  const no=val('lg-empno').trim(); const err=document.getElementById('lg-emperr'); err.textContent='';
  if(!no){ err.textContent='أدخل الرقم الوظيفي'; return; }
  const btn=document.getElementById('lg-empbtn'); btn.disabled=true; btn.textContent='جارٍ الفتح…';
  const { error }=await Cloud.signIn('e'+no+USER_DOMAIN, no);
  btn.disabled=false; btn.textContent='عرض الجدول';
  if(error){ err.textContent='الرقم الوظيفي غير صحيح'; return; }
  await startApp();
}
function applyRole(){ document.body.classList.toggle('viewer', isViewer); }
const USER_DOMAIN='@shift.local';   // اسم المستخدم بلا @ يُكمَّل بهذا النطاق
async function doLogin(){
  let email=val('lg-email').trim(); const pw=val('lg-pass');
  const err=document.getElementById('lg-err'); err.textContent='';
  if(!email||!pw){ err.textContent='أدخل اسم المستخدم وكلمة المرور'; return; }
  if(!email.includes('@')) email=email.toLowerCase()+USER_DOMAIN;
  const btn=document.getElementById('lg-btn'); btn.disabled=true; btn.textContent='جارٍ الدخول…';
  const { error }=await Cloud.signIn(email, pw);
  btn.disabled=false; btn.textContent='دخول';
  if(error){ err.textContent='تعذّر الدخول — تأكد من البريد وكلمة المرور'; return; }
  await startApp();
}
async function startApp(){
  hideLogin();
  // تحديث الجلسة حتى يحمل الرمز أحدث الصلاحيات (app_metadata.role)
  try{ await Cloud.sb.auth.refreshSession(); }catch(e){}
  // تحديد الدور من الحساب
  try{
    const { data }=await Cloud.sb.auth.getUser();
    const u=data&&data.user;
    isViewer = !(u && u.app_metadata && u.app_metadata.role==='admin');
    currentUserEmail = u ? ((u.user_metadata&&u.user_metadata.full_name) || (u.email||'').replace(USER_DOMAIN,'')) : '';
    currentEmpNo = (u && u.user_metadata && u.user_metadata.emp_no) || '';
  }catch(e){ isViewer=false; }
  applyRole();
  const hadCache=loadCache();
  document.getElementById('hSub').textContent=state.settings.department;
  if(!isViewer) await Cloud.flush();
  try{ await Cloud.pull(); }
  catch(e){ if(!hadCache) toast('تعذّر تحميل البيانات — تحقق من الاتصال'); }
  // تعافٍ ذاتي: إن جاءت القراءات فارغة (رمز جلسة منتهٍ) جدّد الجلسة وأعد المحاولة مرّة
  if(state.employees.length===0){
    try{ await Cloud.sb.auth.refreshSession(); await Cloud.pull(); }catch(e){}
  }
  document.getElementById('hSub').textContent=state.settings.department;
  Cloud.subscribe(onRemoteChange);
  updateSyncBadge();
  nav(isViewer ? 'sched' : 'dash');
}
async function boot(){
  if(!window.supabase){
    showLogin();
    document.getElementById('lg-err').textContent='تعذّر تحميل مكوّن المزامنة — تحقق من اتصال الإنترنت ثم أعد فتح الصفحة.';
    return;
  }
  Cloud.init();
  updateSyncBadge();
  let sess=null;
  try{ sess=await Cloud.getSession(); }catch(e){}
  if(sess){ await startApp(); return; }
  showLogin();
  if(/[?&]staff\b/.test(location.search)) showEmpLogin();
}

document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.nav)));
document.getElementById('fab').addEventListener('click',()=>{ if(current==='emps') editEmp(''); else if(current==='leaves') editLeave(''); });
document.getElementById('btnSettings').addEventListener('click', openSettings);

boot();

/* -------------------- التثبيت كتطبيق (PWA) -------------------- */
// service worker بسياسة «الشبكة أولاً» — يجعل التطبيق قابلاً للتثبيت ويعمل دون إنترنت دون نُسخ قديمة
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
let deferredInstall=null;
function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true; }
function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; }
function showInstallBar(msg){
  const bar=document.getElementById('installBar'); if(!bar||isStandalone()) return;
  if(localStorage.getItem('installDismissed')==='1') return;
  if(msg) document.getElementById('installText').textContent=msg;
  bar.style.display='flex';
}
function hideInstallBar(){ const b=document.getElementById('installBar'); if(b) b.style.display='none'; }
function dismissInstall(){ localStorage.setItem('installDismissed','1'); hideInstallBar(); }
async function doInstall(){
  if(deferredInstall){
    deferredInstall.prompt();
    try{ await deferredInstall.userChoice; }catch(e){}
    deferredInstall=null; hideInstallBar();
  } else if(isIOS()){
    openSheet(`
      <h3>تثبيت التطبيق على الآيفون<button class="x" onclick="closeSheet()">×</button></h3>
      <ol style="line-height:2;padding-inline-start:18px;font-size:14px">
        <li>افتح الرابط في متصفح <b>Safari</b>.</li>
        <li>اضغط زر المشاركة <b>⬆️</b> بالأسفل.</li>
        <li>اختر <b>«إضافة إلى الشاشة الرئيسية»</b>.</li>
        <li>اضغط <b>«إضافة»</b> — تظهر أيقونة التطبيق على الشاشة.</li>
      </ol>`);
  } else {
    toast('افتح قائمة المتصفح ثم «تثبيت التطبيق»');
  }
}
window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredInstall=e; showInstallBar(); });
window.addEventListener('appinstalled', ()=>{ deferredInstall=null; hideInstallBar(); toast('تم تثبيت التطبيق'); });
// آيفون: لا يوجد حدث تلقائي — أظهر شريط الإرشاد
if(isIOS() && !isStandalone()) setTimeout(()=>showInstallBar('ثبّت التطبيق على جهازك'), 1200);
