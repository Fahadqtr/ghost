'use client'

/**
 * محرّر مستلمي قناة واحدة.
 *
 * الحقول تبدأ من القيم المحفوظة على الخادم (تصل كخصائص، بلا جلب من المتصفح)،
 * فالصفحة لا تحتاج أي مزامنة عند التحميل. الحفظ فقط هو ما يستدعي الخادم.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RecipientsForm({
  channel, label, initialTo, initialCc, configured, bccSupported,
}: {
  channel: 'talabat' | 'rafeeq'
  label: string
  initialTo: string
  initialCc: string
  configured: boolean
  bccSupported: boolean
}) {
  const router = useRouter()
  const [to, setTo] = useState(initialTo)
  const [cc, setCc] = useState(initialCc)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setState('saving'); setError(null)
    try {
      const res = await fetch('/api/settings/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, to, cc }),
      })
      const body = await res.json()
      if (!res.ok) { setError(body?.message_ar ?? 'تعذّر الحفظ.'); setState('idle'); return }
      setState('saved')
      router.refresh()
    } catch {
      setError('تعذّر الاتصال بالخادم.'); setState('idle')
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{label}</h2>
      <p className="text-sm text-neutral-600">
        الحالة:{' '}
        {configured
          ? <span className="text-emerald-700">مضبوط</span>
          : <span className="text-amber-800">غير مضبوط — لا يمكن الإرسال</span>}
      </p>
      <label className="block text-sm">
        <span className="mb-1 block">إلى (To)</span>
        <input
          type="text" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)}
          className="w-full rounded border border-neutral-300 p-2 font-mono text-sm"
          placeholder="name@company.com"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block">نسخة (CC) — اختياري</span>
        <input
          type="text" dir="ltr" value={cc} onChange={(e) => setCc(e.target.value)}
          className="w-full rounded border border-neutral-300 p-2 font-mono text-sm"
        />
      </label>
      {!bccSupported ? (
        <p className="text-xs text-neutral-500">
          النسخة المخفية (BCC) غير مدعومة حالياً — طبقة الإرسال المشتركة ترسل To وCC فقط.
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        type="button" onClick={() => void save()} disabled={state === 'saving'}
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {state === 'saving' ? 'جارٍ الحفظ…' : 'حفظ'}
      </button>
      {state === 'saved' ? <span className="ms-2 text-sm text-emerald-700">تم الحفظ</span> : null}
    </section>
  )
}
