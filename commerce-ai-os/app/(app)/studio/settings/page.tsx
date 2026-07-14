import { getT } from "@/lib/i18n-server";
import { videoEngineStatus } from "@/app/(app)/studio/actions";
import { voiceEngineStatus } from "@/app/(app)/studio/voice-actions";

export const dynamic = "force-dynamic";

// A single engine-status row (module scope so it isn't re-created per render).
function Row({ ok, okLabel, offLabel, name }: { ok: boolean; okLabel: string; offLabel: string; name: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[#efe3d6] bg-white px-3 py-2">
      <span className="text-sm text-ink">{name}</span>
      <span className={`badge ${ok ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
        {ok ? okLabel : offLabel}
      </span>
    </div>
  );
}

// Malika AI Studio → Settings. Shows which video engines are configured and how
// to enable FLORA. For security the API key is entered in Vercel (env), NOT
// stored in the app database.
export default async function Page() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const s = await videoEngineStatus();
  const voice = await voiceEngineStatus();
  const okLabel = L("مهيأ ✓", "configured ✓");
  const offLabel = L("غير مهيأ", "not set");
  const voiceBadge = {
    connected: { ar: "متصل ✓", en: "connected ✓", cls: "bg-emerald-100 text-emerald-700" },
    not_connected: { ar: "غير متصل", en: "not connected", cls: "bg-slate-100 text-slate-500" },
    error: { ar: "خطأ", en: "error", cls: "bg-red-100 text-red-700" },
  }[voice.state];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</a>
        <span className="text-2xl">⚙️</span>
        <h2 className="text-lg font-semibold text-ink">{L("الإعدادات — محركات الفيديو", "Settings — Video engines")}</h2>
      </div>

      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">{L("حالة المحركات", "Engine status")}</p>
        <Row ok={s.flora} okLabel={okLabel} offLabel={offLabel} name="FLORA" />
        <Row ok={s.higgsfield} okLabel={okLabel} offLabel={offLabel} name="Higgsfield" />
        <p className="text-[11px] text-muted">{L("المزوّد الافتراضي لفيديوهات المنتجات:", "Default provider for product videos:")} <b dir="ltr">{s.defaultProvider}</b></p>
      </div>

      {/* Voice engine — ElevenLabs status. */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">{L("محرك الصوت", "Voice engine")} — ElevenLabs</p>
        <div className="flex items-center justify-between rounded-lg border border-[#efe3d6] bg-white px-3 py-2">
          <span className="text-sm text-ink">ElevenLabs</span>
          <span className={`badge ${voiceBadge.cls}`}>{en ? voiceBadge.en : voiceBadge.ar}</span>
        </div>
        {voice.voiceId ? <p className="text-[11px] text-muted" dir="ltr">Voice ID: {voice.voiceId} · {voice.model}</p> : null}
        {voice.state !== "connected" && voice.detail ? <p className="text-[11px] text-amber-700">{voice.detail}</p> : null}
        <ul className="space-y-1 text-[11px] text-muted" dir="ltr">
          <li><code>ELEVENLABS_API_KEY</code> — {L("مفتاح ElevenLabs", "your ElevenLabs key")}</li>
          <li><code>ELEVENLABS_VOICE_ID</code> — {L("صوت خليجي (قابل للتغيير)", "a Gulf voice (changeable)")}</li>
          <li className="text-violet-700">{L("اختياري:", "Optional:")} <code>ELEVENLABS_MODEL_ID</code> ({L("افتراضي", "default")} eleven_multilingual_v2)</li>
        </ul>
      </div>

      {/* FLORA setup — key goes to Vercel env for security, never the app DB. */}
      <div className="card space-y-2 border-violet-200 bg-violet-50/40">
        <p className="text-sm font-bold text-violet-800">🔑 {L("تفعيل FLORA", "Enable FLORA")}</p>
        <p className="text-xs leading-relaxed text-violet-900">
          {L("لأمان المفاتيح، مفتاح FLORA يُدخل في Vercel (متغيرات البيئة) — مو في قاعدة بيانات التطبيق. أضف التالي ثم Redeploy:",
            "For key security, the FLORA API key is entered in Vercel (environment variables), not the app database. Add these, then Redeploy:")}
        </p>
        <ul className="space-y-1 text-[11px] text-violet-900" dir="ltr">
          <li><code>FLORA_API_KEY</code> — {L("مفتاح FLORA (sk_live_…)", "your FLORA key (sk_live_…)")}</li>
          <li><code>FLORA_TECHNIQUE_SLUG</code> — malikas-product-commercial-v1</li>
          <li className="text-violet-700">{L("اختياري:", "Optional:")} <code>FLORA_API_BASE</code>, <code>VIDEO_PROVIDER</code> (auto/flora/higgsfield), <code>FLORA_SEND_PROMPT</code>=true {L("لو التقنية تقبل برومبت.", "if your technique accepts a prompt input.")}</li>
        </ul>
        <p className="text-[11px] text-muted">
          {L("بدون هذه، فيديوهات المنتجات تستخدم Higgsfield تلقائيًا (ما ينكسر شي).",
            "Until these are set, product videos use Higgsfield automatically (nothing breaks).")}
        </p>
      </div>
    </div>
  );
}
