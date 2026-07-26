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

// مصنع يبني الدوال ضمن بيئة معزولة مع بدائل للاعتماديات
function buildApi({ fromVal, toVal, staleFrom, staleTo }) {
  const state = { confirmMsg: null, alertMsg: null, lockCalls: [], genCalls: [] };
  const inputs = { 'ws-from': { value: fromVal }, 'ws-to': { value: toVal } };
  const document = { getElementById: (id) => inputs[id] || null };
  const esc = (s) => String(s == null ? '' : s);
  const confirmFn = (m) => { state.confirmMsg = m; return true; };
  const alertFn = (m) => { state.alertMsg = m; };
  const rpcErr = (e) => String(e);
  const Cloud = {
    lockSchedule: async (from, to, lock) => { state.lockCalls.push({ from, to, lock }); return { data: { affected: 18 }, error: null }; },
    genSchedule: async (from, to) => { state.genCalls.push({ from, to }); return { data: { created: 0 }, error: null }; },
    getSchedule: async () => ({ data: { items: [] }, error: null }),
  };
  const harness = `
    let wsFrom = ${JSON.stringify(staleFrom)}, wsTo = ${JSON.stringify(staleTo)};
    let wsBusy = false, wsPage = 1, wsData = null, wsLoading = false, wsErr = '';
    let loadCount = 0;
    function renderWsched(){}
    async function loadWsched(){ loadCount++; }
    ${block}
    return {
      wsNormISO, fmtDMY, wsReadRange, doLockRange, doGenSchedule, wsSetRange,
      getState: () => ({ wsFrom, wsTo }),
      getLoadCount: () => loadCount,
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
