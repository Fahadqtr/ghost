// حارس انحدار: زر القفل/التوليد يجب أن يستخدم القيم الحيّة من حقلي التاريخ
// (from/to) لحظة الضغط — مصدر الحقيقة الوحيد — لا state قديمًا/افتراضيًا (todayISO)
// ولا نطاقًا مولّدًا، مع رفض الحقول الفارغة/غير الصالحة والنطاق المعكوس.
//
// يُشغَّل: node --test shift-app/tests/*.test.mjs
//
// يستخرج الدوال الفعلية من app.js ويشغّلها ضمن DOM وهمي، فيختبر المصدر الحقيقي
// لا نسخة منه — بحيث يفشل الاختبار إن عاد أحد إلى قراءة/إبقاء wsFrom/wsTo القديمة.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js');
const appSrc = readFileSync(appPath, 'utf8');

// اقتطاع كتلة دوال الجدول الفعلية من app.js: من wsNormISO حتى بداية wsRow
const start = appSrc.indexOf('function wsNormISO');
const end = appSrc.indexOf('function wsRow(');
assert.ok(start >= 0 && end > start, 'تعذّر اقتطاع دوال الجدول من app.js');
const block = appSrc.slice(start, end);

// مصنع يبني الدوال ضمن بيئة معزولة مع بدائل للاعتماديات.
// خيارات إضافية (اختيارية، بقيم افتراضية تُبقي كل الاختبارات الحالية دون تغيير):
//   confirmReturn: قيمة confirm() (افتراضيًا true)
//   lockResult/genResult: قيمة RPC المُعادة عند النجاح/الخطأ
//   lockThrow/genThrow: Error يُرمى فعليًا من RPC (لاختبار catch)
//   gate: Promise يبقى pending داخل lockSchedule (لاختبار حارس wsBusy)
//   renderThrowFirst: يجعل أول استدعاء لـ renderWsched يرمي (لاختبار فشل render بعد busy)
//   loadThrow: يجعل loadWsched يرمي أثناء التنظيف (لاختبار فشل إعادة التحميل في finally)
function buildApi({
  fromVal = '', toVal = '', staleFrom = '', staleTo = '',
  confirmReturn = true,
  lockResult = { data: { affected: 18 }, error: null },
  genResult = { data: { created: 0 }, error: null },
  lockThrow = null, genThrow = null, gate = null,
  renderThrowFirst = false, loadThrow = false,
} = {}) {
  const state = { confirmMsg: null, alertMsg: null, lockCalls: [], genCalls: [] };
  const inputs = { 'ws-from': { value: fromVal }, 'ws-to': { value: toVal } };
  const document = { getElementById: (id) => inputs[id] || null };
  const esc = (s) => String(s == null ? '' : s);
  const confirmFn = (m) => { state.confirmMsg = m; return confirmReturn; };
  const alertFn = (m) => { state.alertMsg = m; };
  const rpcErr = (e) => (e && e.message) ? String(e.message) : String(e);
  const Cloud = {
    lockSchedule: async (from, to, lock) => {
      state.lockCalls.push({ from, to, lock });
      if (gate) await gate;
      if (lockThrow) throw lockThrow;
      return lockResult;
    },
    genSchedule: async (from, to) => {
      state.genCalls.push({ from, to });
      if (genThrow) throw genThrow;
      return genResult;
    },
    getSchedule: async () => ({ data: { items: [] }, error: null }),
  };
  const harness = `
    let wsFrom = ${JSON.stringify(staleFrom)}, wsTo = ${JSON.stringify(staleTo)};
    let wsBusy = false, wsPage = 1, wsData = null, wsLoading = false, wsErr = '';
    let loadCount = 0, renderCount = 0;
    function renderWsched(){ renderCount++; if(${renderThrowFirst ? 'true' : 'false'} && renderCount === 1) throw new Error('render boom'); }
    async function loadWsched(){ loadCount++; if(${loadThrow ? 'true' : 'false'}) throw new Error('reload boom'); }
    ${block}
    return {
      wsNormISO, fmtDMY, wsReadRange, doLockRange, doGenSchedule, wsSetRange,
      getState: () => ({ wsFrom, wsTo }),
      getLoadCount: () => loadCount,
      getBusy: () => wsBusy,
    };
  `;
  const factory = new Function('document', 'esc', 'confirm', 'alert', 'rpcErr', 'Cloud', harness);
  const api = factory(document, esc, confirmFn, alertFn, rpcErr, Cloud);
  return { api, state };
}

test('wsNormISO: يطبّع/يتحقق YYYY-MM-DD', () => {
  const { api } = buildApi({ fromVal: '', toVal: '', staleFrom: '', staleTo: '' });
  assert.equal(api.wsNormISO('2026-08-03'), '2026-08-03');
  assert.equal(api.wsNormISO(' 2026-08-03 '), '2026-08-03');
  assert.equal(api.wsNormISO('2026/08/03'), '');
  assert.equal(api.wsNormISO('abc'), '');
  assert.equal(api.wsNormISO(''), '');
  assert.equal(api.wsNormISO(null), '');
});

test('fmtDMY: عرض DD-MM-YYYY لرسالة التأكيد', () => {
  const { api } = buildApi({ fromVal: '', toVal: '', staleFrom: '', staleTo: '' });
  assert.equal(api.fmtDMY('2026-08-03'), '03-08-2026');
  assert.equal(api.fmtDMY('2026-08-04'), '04-08-2026');
});

test('wsReadRange: مصدر حقيقة وحيد — يعيّن state دائمًا (لا يبقي القديم عند الفراغ)', () => {
  const { api } = buildApi({ fromVal: '', toVal: '', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  const r = api.wsReadRange();
  assert.deepEqual(r, { from: '', to: '' });
  assert.deepEqual(api.getState(), { wsFrom: '', wsTo: '' });
});

// D) المسار الصحيح
test('D) المسار الصحيح: 2026-08-03 → 2026-08-04، RPC + confirm بصيغة DD-MM-YYYY', async () => {
  const { api, state } = buildApi({ fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await api.doLockRange(true);
  assert.deepEqual(state.lockCalls, [{ from: '2026-08-03', to: '2026-08-04', lock: true }]);
  assert.match(state.confirmMsg, /03-08-2026/);
  assert.match(state.confirmMsg, /04-08-2026/);
  assert.doesNotMatch(state.confirmMsg, /2026-07-26|26-07-2026/);
  assert.deepEqual(api.getState(), { wsFrom: '2026-08-03', wsTo: '2026-08-04' });
});

test('D2) doGenSchedule يستخدم القيم الحيّة', async () => {
  const { api, state } = buildApi({ fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await api.doGenSchedule();
  assert.deepEqual(state.genCalls, [{ from: '2026-08-03', to: '2026-08-04' }]);
});

// A) حقلان فارغان + state قديم كامل ⇒ لا RPC، alert، وstate يصبح فارغًا
test('A) حقول فارغة + stale ⇒ لا lock/gen RPC، alert، state=""', async () => {
  const { api, state } = buildApi({ fromVal: '', toVal: '', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await api.doLockRange(true);
  await api.doGenSchedule();
  assert.equal(state.lockCalls.length, 0, 'لا يجب استدعاء lock');
  assert.equal(state.genCalls.length, 0, 'لا يجب استدعاء generate');
  assert.equal(state.confirmMsg, null, 'لا confirm');
  assert.match(state.alertMsg, /حدّد نطاق التاريخ/);
  assert.deepEqual(api.getState(), { wsFrom: '', wsTo: '' });
});

// B) حقل واحد فقط صالح + state قديم كامل ⇒ لا RPC
test('B) from صالح وto فارغ + stale ⇒ لا RPC', async () => {
  const { api, state } = buildApi({ fromVal: '2026-08-03', toVal: '', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await api.doLockRange(true);
  await api.doGenSchedule();
  assert.equal(state.lockCalls.length, 0);
  assert.equal(state.genCalls.length, 0);
  assert.equal(state.confirmMsg, null);
  assert.match(state.alertMsg, /حدّد نطاق التاريخ/);
  assert.deepEqual(api.getState(), { wsFrom: '2026-08-03', wsTo: '' });
});

// C) نطاق معكوس from > to ⇒ لا RPC، لا confirm، رسالة واضحة
test('C) النطاق معكوس (from > to) ⇒ لا RPC ولا confirm ورسالة واضحة', async () => {
  const { api, state } = buildApi({ fromVal: '2026-08-04', toVal: '2026-08-03', staleFrom: '', staleTo: '' });
  await api.doLockRange(true);
  await api.doGenSchedule();
  assert.equal(state.lockCalls.length, 0);
  assert.equal(state.genCalls.length, 0);
  assert.equal(state.confirmMsg, null, 'لا يجب عرض confirm عند النطاق المعكوس');
  assert.match(state.alertMsg, /البداية بعد/);
});

test('wsSetRange: يرفض الفارغ والمعكوس (لا loadWsched)', async () => {
  const empty = buildApi({ fromVal: '', toVal: '', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await empty.api.wsSetRange();
  assert.equal(empty.api.getLoadCount(), 0, 'لا تحميل عند فراغ الحقول');
  assert.match(empty.state.alertMsg, /حدّد نطاق التاريخ/);

  const rev = buildApi({ fromVal: '2026-08-04', toVal: '2026-08-03', staleFrom: '', staleTo: '' });
  await rev.api.wsSetRange();
  assert.equal(rev.api.getLoadCount(), 0, 'لا تحميل عند النطاق المعكوس');
  assert.match(rev.state.alertMsg, /البداية بعد/);

  const ok = buildApi({ fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '' });
  await ok.api.wsSetRange();
  assert.equal(ok.api.getLoadCount(), 1, 'تحميل واحد عند النطاق الصالح');
});

// 1) الفتح (unlock) الناجح: قيم حيّة، lock=false، رسالة نجاح، إعادة تحميل، wsBusy=false
test('E) unlock ناجح: doLockRange(false) بقيم حيّة + reload + wsBusy=false', async () => {
  const { api, state } = buildApi({ fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '2026-07-26', staleTo: '2026-07-26' });
  await api.doLockRange(false);
  assert.deepEqual(state.lockCalls, [{ from: '2026-08-03', to: '2026-08-04', lock: false }]);
  assert.deepEqual(api.getState(), { wsFrom: '2026-08-03', wsTo: '2026-08-04' }); // لا state قديم
  assert.match(state.confirmMsg, /فتح/);
  assert.match(state.confirmMsg, /03-08-2026/);
  assert.match(state.alertMsg, /تم/);          // رسالة نجاح
  assert.match(state.alertMsg, /18/);
  assert.equal(api.getLoadCount(), 1, 'إعادة تحميل بعد النجاح');
  assert.equal(api.getBusy(), false, 'wsBusy يعود false');
});

// 2) خطأ RPC للقفل: لا نجاح وهمي، رسالة خطأ، wsBusy=false، reload، RPC مرة واحدة
test('F) lock RPC error: لا نجاح وهمي + خطأ + reload + wsBusy=false + استدعاء واحد', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    lockResult: { data: null, error: { message: 'lock failed' } },
  });
  await api.doLockRange(true);
  assert.equal(state.lockCalls.length, 1, 'RPC مرة واحدة فقط');
  assert.match(state.alertMsg, /تعذّر/, 'رسالة خطأ');
  assert.doesNotMatch(state.alertMsg, /تم\s/, 'لا رسالة نجاح');
  assert.equal(api.getLoadCount(), 1, 'إعادة تحميل بعد الفشل');
  assert.equal(api.getBusy(), false);
});

// 3) خطأ RPC للتوليد: لا نجاح وهمي + خطأ + reload + wsBusy=false
test('G) generate RPC error: لا نجاح وهمي + خطأ + reload + wsBusy=false', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    genResult: { data: null, error: { message: 'gen failed' } },
  });
  await api.doGenSchedule();
  assert.equal(state.genCalls.length, 1);
  assert.match(state.alertMsg, /تعذّر التوليد/);
  assert.doesNotMatch(state.alertMsg, /تم التوليد/, 'لا نجاح وهمي');
  assert.equal(api.getLoadCount(), 1, 'إعادة تحميل بعد الفشل');
  assert.equal(api.getBusy(), false);
});

// 4) استثناء مرمي فعليًا: يصل catch، رسالة الاتصال، wsBusy=false، reload
test('H) thrown exception (lock): catch + رسالة اتصال + reload + wsBusy=false', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    lockThrow: new Error('network down'),
  });
  await api.doLockRange(true);
  assert.equal(state.lockCalls.length, 1);
  assert.match(state.alertMsg, /تحقّق من الاتصال/, 'رسالة الاتصال في catch');
  assert.equal(api.getLoadCount(), 1, 'إعادة تحميل حتى بعد الاستثناء');
  assert.equal(api.getBusy(), false, 'لا تبقى الواجهة busy');
});

// 5) حارس wsBusy: استدعاء ثانٍ أثناء طلب pending لا يطلق RPC ثانيًا
test('I) busy guard: استدعاء ثانٍ أثناء pending ⇒ RPC مرة واحدة، ثم wsBusy=false', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '', gate,
  });
  const p1 = api.doLockRange(false);      // يبقى pending على gate
  await api.doLockRange(false);           // يجب أن يرجع فورًا (wsBusy=true)
  assert.equal(state.lockCalls.length, 1, 'استدعاء RPC واحد فقط أثناء pending');
  assert.equal(api.getBusy(), true, 'wsBusy=true أثناء الطلب الجاري');
  release();                              // إنهاء الطلب الأول
  await p1;
  assert.equal(state.lockCalls.length, 1, 'لا استدعاء إضافي بعد الإنهاء');
  assert.equal(api.getBusy(), false, 'wsBusy يعود false بعد الإنهاء');
});

// 6) إلغاء التأكيد: confirm=false ⇒ لا RPC، لا busy، لا reload، لا نجاح
test('J) cancel confirm: confirm=false ⇒ لا RPC/لا busy/لا reload/لا نجاح', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    confirmReturn: false,
  });
  await api.doLockRange(true);
  assert.equal(state.lockCalls.length, 0, 'لا استدعاء lock عند الإلغاء');
  assert.match(state.confirmMsg, /قفل/, 'عُرض confirm');
  assert.equal(state.alertMsg, null, 'لا رسالة نجاح/خطأ');
  assert.equal(api.getLoadCount(), 0, 'لا إعادة تحميل عند الإلغاء');
  assert.equal(api.getBusy(), false, 'wsBusy لم يتحوّل true');
});

// 7) إصلاح finally — فشل renderWsched بعد تفعيل busy في doGenSchedule:
//    renderWsched أصبح داخل try، فالرمي يصل catch؛ لا يُطلَق RPC؛ finally يعيد busy=false
//    ولا يبقى الإجراء عالقًا (استدعاء لاحق يمرّ ويطلق RPC).
test('K) doGenSchedule: رمي render بعد busy ⇒ لا RPC + رسالة اتصال + busy=false + غير عالق', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    renderThrowFirst: true,
  });
  await api.doGenSchedule();
  assert.equal(state.genCalls.length, 0, 'render رمى قبل await ⇒ لا استدعاء genSchedule');
  assert.match(state.alertMsg, /تعذّر التوليد — تحقّق من الاتصال/, 'رسالة الاتصال الحالية عبر catch');
  assert.equal(api.getBusy(), false, 'busy=false في finally رغم رمي render');
  // غير عالق: الاستدعاء التالي (render لم يعد يرمي) يمرّ ويطلق RPC مرة واحدة
  await api.doGenSchedule();
  assert.equal(state.genCalls.length, 1, 'الاستدعاء التالي غير محجوب ويطلق RPC');
  assert.equal(api.getBusy(), false);
});

// 8) إصلاح finally — فشل loadWsched أثناء التنظيف في doGenSchedule:
//    busy=false يحدث قبل await التنظيف؛ خطأ التنظيف مُمتَص داخليًا (لا rejection معلّق)؛
//    لا نجاح وهمي إضافي؛ لا تكرار RPC.
test('L) doGenSchedule: رمي loadWsched في finally ⇒ busy=false + لا rejection + لا تكرار RPC', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    genResult: { data: { created: 2 }, error: null },
    loadThrow: true,
  });
  await assert.doesNotReject(() => api.doGenSchedule(), 'خطأ التنظيف مُمتَص — لا rejection');
  assert.equal(state.genCalls.length, 1, 'RPC مرة واحدة (لا تكرار)');
  assert.match(state.alertMsg, /تم التوليد/, 'رسالة النجاح الأصلية باقية');
  assert.doesNotMatch(state.alertMsg, /تعذّر/, 'لا رسالة خطأ/نجاح وهمي من التنظيف');
  assert.equal(api.getLoadCount(), 1, 'حاول إعادة التحميل مرة واحدة');
  assert.equal(api.getBusy(), false, 'busy=false رغم فشل التنظيف');
});

// 9) مسار القفل عبر finally — استثناء RPC يعيد busy=false، إعادة تحميل مرة واحدة،
//    والاستدعاء التالي غير محجوب بحالة busy قديمة.
test('M) doLockRange: استثناء RPC ⇒ busy=false + reload مرة + الاستدعاء التالي غير محجوب', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04', staleFrom: '', staleTo: '',
    lockThrow: new Error('network down'),
  });
  await api.doLockRange(true);
  assert.equal(state.lockCalls.length, 1, 'استدعاء lock مرة');
  assert.match(state.alertMsg, /تحقّق من الاتصال/, 'رسالة الاتصال في catch');
  assert.equal(api.getLoadCount(), 1, 'إعادة تحميل مرة واحدة بعد الاستثناء');
  assert.equal(api.getBusy(), false, 'busy=false في finally');
  // الاستدعاء التالي غير محجوب بحالة busy قديمة
  await api.doLockRange(false);
  assert.equal(state.lockCalls.length, 2, 'الاستدعاء التالي مرّ (لم يُحجب بـ busy قديم)');
  assert.equal(api.getBusy(), false);
});
