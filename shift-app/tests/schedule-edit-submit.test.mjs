// حارس انحدار: زر «حفظ» في تعديل يوم الجدول (confirmSchedEdit) يجب أن يمنع
// الإرسال المكرر (double-submit) — استدعاء RPC مرة واحدة فقط أثناء طلب جارٍ،
// وعودة حالة الانشغال إلى false في كل المسارات (نجاح/خطأ RPC/استثناء/فشل تنظيف).
//
// يُشغَّل: node --test shift-app/tests/*.test.mjs
//
// يستخرج دالة confirmSchedEdit الفعلية من app.js ويشغّلها ضمن DOM وهمي،
// فيختبر المصدر الحقيقي لا نسخة منه.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js');
const appSrc = readFileSync(appPath, 'utf8');

// اقتطاع دالة confirmSchedEdit الفعلية: من تعريفها حتى بداية قسم «تعريف الورديات»
const start = appSrc.indexOf('async function confirmSchedEdit');
const end = appSrc.indexOf('/* ---- تعريف الورديات ---- */');
assert.ok(start >= 0 && end > start, 'تعذّر اقتطاع confirmSchedEdit من app.js');
const block = appSrc.slice(start, end);

// مصنع يبني الدالة ضمن بيئة معزولة مع بدائل للاعتماديات.
//   working/defId/reason: قيم الحقول
//   updResult: قيمة RPC المُعادة (نجاح/خطأ)
//   updThrow: Error يُرمى فعليًا من RPC (لاختبار catch)
//   gate: Promise يبقى pending داخل updSchedule (لاختبار حارس busy)
//   loadThrow: يجعل loadWsched يرمي أثناء التنظيف
function buildApi({
  working = '1', defId = 'd-1', reason = 'تصحيح وردية',
  updResult = { error: null }, updThrow = null, gate = null, loadThrow = false,
} = {}) {
  const state = { alertMsg: null, updCalls: [], modalRemoved: false };
  const saveBtn = { disabled: false };
  const inputs = {
    'se-working': { value: working },
    'se-def': { value: defId },
    'se-reason': { value: reason },
    'se-save': saveBtn,
    'sched-edit-modal': { remove() { state.modalRemoved = true; } },
  };
  const document = { getElementById: (id) => (id in inputs ? inputs[id] : null) };
  const alertFn = (m) => { state.alertMsg = m; };
  const rpcErr = (e) => (e && e.message) ? String(e.message) : String(e);
  const Cloud = {
    updSchedule: async (emp, date, def, work, why) => {
      state.updCalls.push({ emp, date, def, work, why });
      if (gate) await gate;
      if (updThrow) throw updThrow;
      return updResult;
    },
  };
  const harness = `
    let wsEditBusy = false, wsEditEmp = 'emp-1', wsEditDate = '2026-08-01';
    let loadCount = 0;
    function renderWsched(){}
    async function loadWsched(){ loadCount++; if(${loadThrow ? 'true' : 'false'}) throw new Error('reload boom'); }
    ${block}
    return {
      confirmSchedEdit,
      getBusy: () => wsEditBusy,
      getLoadCount: () => loadCount,
      getBtnDisabled: () => (${'saveBtnRef'}).disabled,
    };
  `;
  // نمرّر مرجع الزر كي يقرأ الاختبار disabled أثناء الطلب الجاري
  const factory = new Function('document', 'alert', 'rpcErr', 'Cloud', 'saveBtnRef', harness);
  const api = factory(document, alertFn, rpcErr, Cloud, saveBtn);
  return { api, state };
}

// A) حارس الإرسال المكرر: استدعاء ثانٍ أثناء طلب pending لا يطلق RPC ثانيًا
test('A) double submit: استدعاء ثانٍ أثناء pending ⇒ RPC مرة واحدة، ثم busy=false', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, state } = buildApi({ gate });
  const p1 = api.confirmSchedEdit();      // يبقى pending على gate
  await api.confirmSchedEdit();            // يجب أن يرجع فورًا (busy=true)
  assert.equal(state.updCalls.length, 1, 'استدعاء RPC واحد فقط أثناء pending');
  assert.equal(api.getBusy(), true, 'busy=true أثناء الطلب الجاري');
  assert.equal(api.getBtnDisabled(), true, 'زر الحفظ معطّل أثناء الطلب');
  release();
  await p1;
  assert.equal(state.updCalls.length, 1, 'لا استدعاء إضافي بعد الإنهاء');
  assert.equal(api.getBusy(), false, 'busy يعود false بعد الإنهاء');
  assert.equal(api.getBtnDisabled(), false, 'زر الحفظ يُعاد تفعيله بعد الإنهاء');
});

// B) خطأ RPC: لا نجاح وهمي، رسالة الخطأ الحالية، busy=false، لا إعادة تحميل (كالسلوك الحالي)
test('B) RPC error: رسالة خطأ + بلا reload (السلوك الحالي) + busy=false + استدعاء واحد', async () => {
  const { api, state } = buildApi({ updResult: { error: { message: 'edit failed' } } });
  await api.confirmSchedEdit();
  assert.equal(state.updCalls.length, 1, 'RPC مرة واحدة');
  assert.match(state.alertMsg, /تعذّر/, 'رسالة الخطأ الحالية');
  assert.equal(state.modalRemoved, false, 'النافذة تبقى مفتوحة عند الخطأ');
  assert.equal(api.getLoadCount(), 0, 'لا إعادة تحميل عند الخطأ (كالسلوك الحالي)');
  assert.equal(api.getBusy(), false, 'busy=false بعد الخطأ');
  assert.equal(api.getBtnDisabled(), false, 'الزر يُعاد تفعيله بعد الخطأ');
});

// C) استثناء مرمي: يصل catch، رسالة الاتصال، busy=false، والاستدعاء التالي مسموح
test('C) thrown exception: catch + رسالة اتصال + busy=false + الاستدعاء التالي غير محجوب', async () => {
  const { api, state } = buildApi({ updThrow: new Error('network down') });
  await api.confirmSchedEdit();
  assert.equal(state.updCalls.length, 1);
  assert.match(state.alertMsg, /تحقّق من الاتصال/, 'رسالة الاتصال في catch');
  assert.equal(api.getBusy(), false, 'busy=false بعد الاستثناء');
  assert.equal(api.getLoadCount(), 0, 'لا reload عند الاستثناء (لم ينجح)');
  // الاستدعاء التالي غير محجوب بحالة busy قديمة
  await api.confirmSchedEdit();
  assert.equal(state.updCalls.length, 2, 'الاستدعاء التالي مرّ (لم يُحجب)');
  assert.equal(api.getBusy(), false);
});

// D) فشل التنظيف: RPC ينجح ثم loadWsched يرمي ⇒ لا rejection معلّق، busy=false، لا تكرار RPC
test('D) cleanup failure: نجاح ثم رمي loadWsched ⇒ بلا rejection + busy=false + بلا نجاح وهمي', async () => {
  const { api, state } = buildApi({ updResult: { error: null }, loadThrow: true });
  await assert.doesNotReject(() => api.confirmSchedEdit(), 'خطأ التنظيف مُمتَص — لا rejection');
  assert.equal(state.updCalls.length, 1, 'RPC مرة واحدة (بلا تكرار)');
  assert.equal(state.modalRemoved, true, 'النافذة أُغلقت عند النجاح');
  assert.equal(api.getLoadCount(), 1, 'حاول إعادة التحميل مرة واحدة');
  assert.equal(state.alertMsg, null, 'لا رسالة خطأ من التنظيف (لا نجاح/فشل وهمي)');
  assert.equal(api.getBusy(), false, 'busy=false رغم فشل التنظيف');
  assert.equal(api.getBtnDisabled(), false);
});

// E) السبب الفارغ (validation): لا busy، لا RPC، لا reload
test('E) validation: سبب فارغ ⇒ لا RPC/لا busy/لا reload', async () => {
  const { api, state } = buildApi({ reason: '   ' });
  await api.confirmSchedEdit();
  assert.equal(state.updCalls.length, 0, 'لا استدعاء RPC عند السبب الفارغ');
  assert.match(state.alertMsg, /السبب إلزامي/, 'رسالة التحقّق الحالية');
  assert.equal(api.getBusy(), false, 'busy لم يتحوّل true');
  assert.equal(api.getLoadCount(), 0, 'لا إعادة تحميل');
  assert.equal(api.getBtnDisabled(), false, 'الزر لم يُعطّل');
});
