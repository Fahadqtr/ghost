// حارس انحدار: زر القفل/التوليد يجب أن يستخدم القيم الحيّة من حقلي التاريخ
// (from/to) لحظة الضغط، لا state قديمًا/افتراضيًا (todayISO) ولا نطاقًا مولّدًا.
//
// يُشغَّل: node --test shift-app/tests/lock-date-range.test.mjs
//
// يستخرج الدوال الفعلية من app.js ويشغّلها ضمن DOM وهمي، فيختبر المصدر الحقيقي
// لا نسخة منه — بحيث يفشل الاختبار إن عاد أحد إلى قراءة wsFrom/wsTo القديمة.
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
  const inputs = {
    'ws-from': { value: fromVal },
    'ws-to': { value: toVal },
  };
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
    function renderWsched(){}
    async function loadWsched(){}
    ${block}
    return {
      wsNormISO, fmtDMY, wsReadRange, doLockRange, doGenSchedule,
      getState: () => ({ wsFrom, wsTo }),
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
  assert.equal(api.wsNormISO('2026/08/03'), '');   // صيغة غير صالحة تُرفض
  assert.equal(api.wsNormISO(''), '');
  assert.equal(api.wsNormISO(null), '');
});

test('fmtDMY: عرض DD-MM-YYYY لرسالة التأكيد', () => {
  const { api } = buildApi({ fromVal: '', toVal: '', staleFrom: '', staleTo: '' });
  assert.equal(api.fmtDMY('2026-08-03'), '03-08-2026');
  assert.equal(api.fmtDMY('2026-08-04'), '04-08-2026');
});

test('doLockRange: يستخدم القيم الحيّة من الحقول لا الـstate القديم (regression)', async () => {
  // المستخدم فتح الشاشة (افتراضي=اليوم 2026-07-26) ثم غيّر الحقول إلى 08-03/08-04 دون «عرض»
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04',
    staleFrom: '2026-07-26', staleTo: '2026-07-26',
  });
  await api.doLockRange(true);
  // RPC يجب أن يرسل التواريخ الحيّة بصيغة YYYY-MM-DD
  assert.deepEqual(state.lockCalls, [{ from: '2026-08-03', to: '2026-08-04', lock: true }]);
  // رسالة التأكيد تعرض DD-MM-YYYY للتواريخ الصحيحة، لا تاريخ اليوم القديم
  assert.match(state.confirmMsg, /03-08-2026/);
  assert.match(state.confirmMsg, /04-08-2026/);
  assert.doesNotMatch(state.confirmMsg, /2026-07-26|26-07-2026/);
  // الـstate الداخلي وُحّد على القيم الحيّة بصيغة YYYY-MM-DD
  assert.deepEqual(api.getState(), { wsFrom: '2026-08-03', wsTo: '2026-08-04' });
});

test('doGenSchedule: أيضًا يستخدم القيم الحيّة لا الـstate القديم', async () => {
  const { api, state } = buildApi({
    fromVal: '2026-08-03', toVal: '2026-08-04',
    staleFrom: '2026-07-26', staleTo: '2026-07-26',
  });
  await api.doGenSchedule();
  assert.deepEqual(state.genCalls, [{ from: '2026-08-03', to: '2026-08-04' }]);
});

test('لا حقول صالحة ⇒ لا استدعاء RPC', async () => {
  const { api, state } = buildApi({ fromVal: '', toVal: '', staleFrom: '', staleTo: '' });
  await api.doLockRange(true);
  assert.equal(state.lockCalls.length, 0);
  assert.match(state.alertMsg, /حدّد نطاق التاريخ/);
});
