/* ============================================================
   تطبيق إدارة الورديات — قسم العمليات الجمركية (نسخة سحابية متزامنة)
   البيانات مشتركة بين كل الأجهزة عبر Supabase، وتُحفظ نسخة محلية للعمل دون إنترنت.
   ============================================================ */
'use strict';

const WORK_SHIFTS = ['صباح', 'عصر', 'ليل'];
const REST = 'راحة';
const AR_DAYS = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

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
function approvedLeave(empId, iso){
  return state.leaves.find(l=>l.empId===empId && l.status==='معتمد' && iso>=l.from && iso<=l.to);
}
function cellValue(emp, iso){
  const ov=state.overrides[emp.id];
  if(ov && ov[iso]) return { value: ov[iso], source:'manual' };
  const lv=approvedLeave(emp.id, iso);
  if(lv) return { value: lv.type, source:'leave' };
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
function renderDash(){
  const iso=toISO(today()), st=dayStats(iso), s=state.settings, low=st.working<s.minWorkers;
  const el=document.getElementById('scr-dash');
  const soon=state.leaves.filter(l=>l.status==='معتمد' && daysBetween(iso,l.from)>=0 && daysBetween(iso,l.from)<=7);
  const perEmp={}; state.employees.forEach(e=>perEmp[e.id]=0);
  state.leaves.filter(l=>l.status==='معتمد').forEach(l=>{ if(perEmp[l.empId]!=null) perEmp[l.empId]+=inclusiveDays(l.from,l.to); });
  const pending=state.leaves.filter(l=>l.status==='قيد الانتظار').length;
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
      const marks=(cv.source==='manual'?'edited ':'')+(iso===todayISO?'today ':'')+(iso===highlightDate?'jump':'');
      tds+=`<td class="daycell ${classFor(cv.value)} ${marks}" onclick="editCell('${e.id}','${iso}')">${labelShort(cv.value)}</td>`;
    }
    return `<tr><td class="namecol">${e.name}<div class="meta" style="font-weight:400;font-size:11px">${e.no}</div></td>${tds}</tr>`;
  }).join('');
  const shiftRows=WORK_SHIFTS.map(sh=>{
    let cells='';
    for(let d=1;d<=days;d++){ cells+=`<td>${dayStats(toISO(new Date(y,m,d))).counts[sh]}</td>`; }
    return `<tr><td class="namecol">${sh}</td>${cells}</tr>`;
  }).join('');
  let totalCells='';
  for(let d=1;d<=days;d++){ const w=dayStats(toISO(new Date(y,m,d))).working; totalCells+=`<td class="${w<state.settings.minWorkers?'low':''}">${w}</td>`; }
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
        <tfoot>${shiftRows}<tr><td class="namecol">إجمالي العاملين</td>${totalCells}</tr></tfoot>
      </table>
    </div>
    <div class="leg">
      <span><i style="background:var(--morning-l)"></i>صباح</span>
      <span><i style="background:var(--amber-l)"></i>عصر</span>
      <span><i style="background:var(--indigo-l)"></i>ليل</span>
      <span><i style="background:#fff;border:1px solid var(--line)"></i>راحة</span>
      <span><i style="background:var(--red-l)"></i>إجازة</span>
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
      <div class="field"><label>من تاريخ</label><input id="l-from" type="date" value="${l?l.from:s.scheduleStart}" oninput="updLeaveHint()"></div>
      <div class="field"><label>إلى تاريخ</label><input id="l-to" type="date" value="${l?l.to:s.scheduleStart}" oninput="updLeaveHint()"></div>
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

/* -------------------- كشف يومي -------------------- */
let dailyDate=null;
function renderDaily(){
  if(!dailyDate) dailyDate=toISO(today());
  const el=document.getElementById('scr-daily'), iso=dailyDate, st=dayStats(iso);
  const rows=state.employees.map((e,i)=>{
    const v=cellValue(e,iso).value, cls=v===''?'':(isLeaveValue(v)?'b-leave':'b-'+(WORK_SHIFTS.includes(v)?v:'راحة'));
    return `<div class="daily-emp"><div style="width:22px;color:var(--muted)">${i+1}</div>
      <div class="grow"><div class="name">${e.name}</div><div class="meta">${e.no}</div></div>
      <span class="badge ${cls}">${v||'—'}</span></div>`;
  }).join('');
  el.innerHTML=`
    <h2 class="title">كشف الوردية اليومي</h2>
    <div class="card no-print"><div class="field" style="margin:0"><label>اختر التاريخ</label>
      <input type="date" value="${iso}" onchange="dailyDate=this.value;renderDaily()"></div></div>
    <div class="card">
      <div style="text-align:center;border-bottom:2px solid var(--teal);padding-bottom:8px;margin-bottom:8px">
        <div style="font-weight:800">${state.settings.department}</div>
        <div style="font-size:13px;color:var(--muted)">كشف الوردية اليومي</div>
        <div style="font-size:13px;margin-top:4px"><b>${AR_DAYS[parseISO(iso).getDay()]}</b> — ${fmtDate(iso)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:10px;font-size:12px">
        <span class="badge b-صباح">صباح ${st.counts.صباح}</span>
        <span class="badge b-عصر">عصر ${st.counts.عصر}</span>
        <span class="badge b-ليل">ليل ${st.counts.ليل}</span>
        <span class="badge b-راحة">راحة ${st.counts.راحة}</span>
        <span class="badge b-leave">مُجاز ${st.onLeave}</span>
      </div>
      ${rows||'<div class="empty">لا يوجد موظفون</div>'}
      <div style="margin-top:16px;font-size:13px;color:var(--muted)">توقيع المشرف: ____________________</div>
    </div>
    <button class="btn block no-print" onclick="window.print()">🖨️ طباعة / حفظ PDF</button>`;
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
    <button class="btn block" onclick="saveSettings()">حفظ الإعدادات</button>
    <button class="btn block ghost" style="margin-top:8px" onclick="refreshFromCloud()">↻ تحديث من السحابة</button>

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
  Data.saveSettings(); closeSheet(); document.getElementById('hSub').textContent=s.department; renderScreen(current); toast('تم حفظ الإعدادات');
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

/* service worker للعمل دون إنترنت */
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
