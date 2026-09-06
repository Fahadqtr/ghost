/**
 * الإعدادات ← البريد — Settings → Email (SERVER COMPONENT)
 *
 * مكان واحد يعرض من نُرسل باسمه، وإلى من نرسل في كل قناة.
 *
 * حالة "موثّق" هنا ليست وسماً تجميلياً: تأتي من مقارنة هوية المرسل بعنوان
 * النقل الذي وثّقه مزوّد البريد فعلاً. لذلك قد تظهر هوية افتراضية وغير قابلة
 * للاختيار في الوقت نفسه — وهذا هو المقصود، لأن كونها الافتراضية لا يثبت
 * التوثيق.
 *
 * القراءة تتم على الخادم خلف بوابة المالك، ولا تُعرض أي بيانات اعتماد: التشخيص
 * يذكر أسماء المتغيّرات الناقصة فقط، لا قيمها.
 */

import { requireOwner } from '@/lib/malak/authz'
import { getEmailSettings } from '@/lib/talabat/email-send.server'
import { RecipientsForm } from './recipients-form'

export const dynamic = 'force-dynamic'

const VERIFICATION_AR: Record<'verified' | 'unverified' | 'no_transport', string> = {
  verified: 'موثّق لدى مزوّد البريد',
  unverified: 'غير موثّق — النقل يرسل من عنوان آخر',
  no_transport: 'لم يتم إعداد خدمة البريد بعد',
}

export default async function EmailSettingsPage() {
  const owner = await requireOwner()
  if (!owner.ok) {
    return <main dir="rtl" className="p-6 text-sm text-red-700">{owner.error}</main>
  }
  const data = await getEmailSettings()

  return (
    <main dir="rtl" className="mx-auto max-w-3xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">الإعدادات ← البريد</h1>
        <p className="mt-1 text-sm text-neutral-600">
          هويات المرسل ومستلمو كل قناة. لا تُعرض هنا أي بيانات اعتماد.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">هويات المرسل</h2>
        <p className="text-sm text-neutral-600">
          العنوان الموثّق حالياً لدى مزوّد البريد:{' '}
          <span className="font-mono">{data.authenticatedFrom ?? 'غير مضبوط'}</span>
        </p>
        <ul className="space-y-2">
          {data.senders.map((s) => (
            <li key={s.address} className="rounded border border-neutral-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.displayName}</span>
                <span className="font-mono text-neutral-600">{s.address}</span>
                {s.isDefault ? <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">افتراضي</span> : null}
                <span className={`rounded px-2 py-0.5 text-xs ${s.active ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-600'}`}>
                  {s.active ? 'مفعّلة' : 'غير مفعّلة'}
                </span>
                <span className={`rounded px-2 py-0.5 text-xs ${s.verification === 'verified' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                  {VERIFICATION_AR[s.verification]}
                </span>
              </div>
              {s.blockedReason ? <p className="mt-2 text-xs text-amber-800">{s.blockedReason}</p> : null}
            </li>
          ))}
        </ul>
        {data.guidance.length > 0 ? (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">الإرسال متوقف — المطلوب:</p>
            <ul className="mt-1 list-disc space-y-1 pe-5">
              {data.guidance.map((g) => <li key={g}>{g}</li>)}
            </ul>
          </div>
        ) : null}
        {data.blockingEnvNames.length > 0 ? (
          <p className="text-xs text-neutral-600">
            متغيّرات ناقصة (أسماء فقط): <span className="font-mono">{data.blockingEnvNames.join(', ')}</span>
          </p>
        ) : null}
      </section>

      <RecipientsForm
        channel="talabat" label="مستلمو طلبات"
        initialTo={data.talabat.to.join(', ')} initialCc={data.talabat.cc.join(', ')}
        configured={data.talabat.configured} bccSupported={data.bccSupported}
      />
      <RecipientsForm
        channel="rafeeq" label="مستلمو رفيق"
        initialTo={data.rafeeq.to.join(', ')} initialCc={data.rafeeq.cc.join(', ')}
        configured={data.rafeeq.configured} bccSupported={data.bccSupported}
      />
    </main>
  )
}
