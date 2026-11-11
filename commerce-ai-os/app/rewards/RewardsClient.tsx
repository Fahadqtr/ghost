"use client";

// Customer-facing Beauty Rewards flow, reached from the printed QR.
// 1. Register with name + phone (remembered on the device so returning
//    customers land straight on their card).
// 2. See the rewards card with hearts filled by APPROVED Snoonu reviews.
// 3. Upload a screenshot of a new review → it queues for the owner's approval.
import { useEffect, useState } from "react";
import { Heart } from "./Heart";
import { PureSeoulFrame, Stamp, PureSeoulPromise } from "./PureSeoulTheme";
import BrandLogo from "@/components/BrandLogo";
import { rewardsSteps } from "@/lib/loyalty/guide";
import { BRAND_INFO, DEFAULT_BRAND, type LoyaltyBrand } from "@/lib/loyalty/brand";

type PrizeOption = { id: string; name: string; imageUrl: string };

type RewardState = {
  name: string;
  phone: string;
  stamps: number;
  required: number;
  rewardReady: boolean;
  cyclesCompleted: number;
  pending: number;
  lastStatus: "pending" | "approved" | "rejected" | null;
  prizes: PrizeOption[];
  chosenPrizeId: string | null;
  voucherCode: string | null;
};

// Per-store colour theme as CSS variables. Malika's values are exactly the
// colours this page always used; Pure Seoul follows its printed card
// (crimson + gold on pink satin, cherry blossoms).
const THEME_VARS: Record<LoyaltyBrand, React.CSSProperties> = {
  malikas: {
    "--rw-bg": "linear-gradient(160deg,#fdf2f4 0%,#faeef0 45%,#f7ead9 100%)",
    "--rw-primary": "#d17c93",
    "--rw-primary2": "#e59aad",
    "--rw-grad": "linear-gradient(90deg,#e59aad,#d17c93)",
    "--rw-muted": "#8a7a6a",
    "--rw-text": "#6b5b4b",
    "--rw-gold": "#c9a24b",
    "--rw-frame": "#d9b45f",
    "--rw-line": "#e8cdb5",
    "--rw-line2": "#f0dcc6",
    "--rw-soft": "#fbeef0",
    "--rw-faint": "#b58aa0",
  } as React.CSSProperties,
  pureseoul: {
    "--rw-bg": "linear-gradient(180deg,#fde9f0 0%,#fbdbe5 50%,#fde4ec 100%)",
    "--rw-primary": "#a80f39",
    "--rw-primary2": "#d4567a",
    "--rw-grad": "linear-gradient(90deg,#c21d4f,#a80f39)",
    "--rw-muted": "#7a5563",
    "--rw-text": "#3f2a31",
    "--rw-gold": "#b98a2e",
    "--rw-frame": "#d9a94a",
    "--rw-line": "#efbfd0",
    "--rw-line2": "#f3c9d7",
    "--rw-soft": "#fde4ec",
    "--rw-faint": "#b0587a",
  } as React.CSSProperties,
};

export default function RewardsClient({ brand = DEFAULT_BRAND }: { brand?: LoyaltyBrand }) {
  const info = BRAND_INFO[brand];
  const LS_KEY = info.storageKey;
  const [state, setState] = useState<RewardState | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  // Returning customer: replay their saved name/phone to refresh the card. All
  // state writes happen inside the async closure (not synchronously in the
  // effect body) so mount stays a single, clean transition.
  useEffect(() => {
    let cancelled = false;
    let saved: { name?: string; phone?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    } catch {
      /* ignore corrupt storage */
    }
    (async () => {
      if (saved?.name && saved?.phone) await fetchState(saved.name, saved.phone);
      if (!cancelled) setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchState(n: string, p: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch("/api/rewards/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, phone: p, brand }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "تعذّرت العملية.");
        return false;
      }
      setState(data.state);
      localStorage.setItem(LS_KEY, JSON.stringify({ name: n, phone: p }));
      return true;
    } catch {
      setError("تعذّر الاتصال. حاولي مرة ثانية.");
      return false;
    }
  }

  async function onRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await fetchState(name, phone);
    setLoading(false);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file || !state) return;
    setUploading(true);
    setError(null);
    setJustSubmitted(false);
    try {
      const fd = new FormData();
      fd.append("phone", state.phone);
      fd.append("brand", brand);
      fd.append("file", file);
      const res = await fetch("/api/rewards/submit", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "تعذّر رفع الصورة.");
      } else {
        setState(data.state);
        setJustSubmitted(true);
      }
    } catch {
      setError("تعذّر الاتصال. حاولي مرة ثانية.");
    } finally {
      setUploading(false);
      input.value = ""; // allow re-selecting the same file
    }
  }

  async function onChoosePrize(prizeId: string) {
    if (!state) return;
    setError(null);
    try {
      const res = await fetch("/api/rewards/choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: state.phone, prizeId, brand }),
      });
      const data = await res.json();
      if (!res.ok || data.error) setError(data.error || "تعذّر اختيار الجائزة.");
      else setState(data.state);
    } catch {
      setError("تعذّر الاتصال. حاولي مرة ثانية.");
    }
  }

  function switchCustomer() {
    localStorage.removeItem(LS_KEY);
    setState(null);
    setName("");
    setPhone("");
    setJustSubmitted(false);
    setError(null);
  }

  return (
    <main
      dir="rtl"
      className="flex min-h-dvh items-center justify-center p-4"
      style={{ background: "var(--rw-bg)", ...THEME_VARS[brand] }}
    >
      <div className="w-full max-w-md">
        <Card brand={brand}>
          {booting ? (
            <div className="py-16 text-center text-[var(--rw-primary)] opacity-70">جارٍ التحميل…</div>
          ) : state ? (
            <CardView
              brand={brand}
              state={state}
              uploading={uploading}
              justSubmitted={justSubmitted}
              onUpload={onUpload}
              onChoosePrize={onChoosePrize}
              onSwitch={switchCustomer}
              error={error}
            />
          ) : (
            <RegisterView
              brand={brand}
              name={name}
              phone={phone}
              setName={setName}
              setPhone={setPhone}
              onSubmit={onRegister}
              loading={loading}
              error={error}
            />
          )}
        </Card>
        <Guide required={state?.required ?? 6} storeName={info.storeName} />
        {brand === DEFAULT_BRAND && (
          <p className="mt-4 text-center text-xs text-[var(--rw-faint)]">
            {info.wordmark} · مكافآت الجمال
          </p>
        )}
      </div>
    </main>
  );
}

/** Collapsible «الطريقة والشروط» guide — the how-to steps + the rules, shown
 *  under the card on both the register and the card views. */
function Guide({ required, storeName }: { required: number; storeName: string }) {
  const steps = rewardsSteps(required, undefined, storeName);
  return (
    <details className="group mt-4 overflow-hidden rounded-2xl border border-[var(--rw-line)] bg-white/90 text-right shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-bold text-[var(--rw-primary)]">
        <span>📖 دليل المكافآت — الطريقة</span>
        <span className="text-[var(--rw-gold)] transition group-open:rotate-180">▾</span>
      </summary>
      <div className="space-y-4 px-4 pb-4">
        <div>
          <p className="mb-1.5 text-xs font-bold tracking-wide text-[var(--rw-gold)]">الطريقة · كيف تشاركين</p>
          <ol className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-[var(--rw-text)]">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--rw-soft)] text-[11px] font-bold text-[var(--rw-primary)]">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </details>
  );
}

/** The gold-framed floral card shell shared by both views. */
function Card({ children, brand }: { children: React.ReactNode; brand: LoyaltyBrand }) {
  if (brand === "pureseoul") return <PureSeoulFrame>{children}</PureSeoulFrame>;
  const info = BRAND_INFO[brand];
  return (
    <div
      className="relative overflow-hidden rounded-3xl bg-white/95 p-6 shadow-xl sm:p-8"
      style={{ border: "2px solid var(--rw-frame)", boxShadow: "0 20px 50px -20px rgba(180,120,90,.4)" }}
    >
      {/* soft corner flourishes echoing the printed roses */}
      <span className="pointer-events-none absolute -right-3 -top-3 text-4xl opacity-30 select-none">🌸</span>
      <span className="pointer-events-none absolute -bottom-3 -left-3 text-4xl opacity-30 select-none">🌸</span>
      <div className="mb-4 text-center">
        {brand === DEFAULT_BRAND ? (
          <BrandLogo className="mx-auto h-14 w-auto text-[#1f1a17]" />
        ) : (
          <p className="font-serif text-3xl font-bold tracking-[0.12em] text-[#1f1a17]">
            {info.storeName}
          </p>
        )}
        {brand === DEFAULT_BRAND && (
          <p className="mt-1 text-[11px] font-semibold tracking-[0.35em] text-[var(--rw-gold)]">
            {info.wordmark}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function RegisterView(props: {
  brand: LoyaltyBrand;
  name: string;
  phone: string;
  setName: (v: string) => void;
  setPhone: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <form onSubmit={props.onSubmit} className="text-center">
      {props.brand === "pureseoul" ? (
        // Logo, title and tagline are part of the Pure Seoul frame artwork.
        <PureSeoulPromise />
      ) : (
        <>
          <h1 className="text-2xl font-bold text-[var(--rw-primary)]">بطاقة مكافآت الجمال</h1>
          <p className="mt-1 text-sm text-[var(--rw-muted)]">لأن جمالك يستحق المكافأة.</p>
          <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-[var(--rw-text)]">
            اجمعي <b>ست ختمات</b> واختاري أي منتج من المتجر مجاناً. سجّلي بياناتك
            وارفقي صورة تقييمك في سنونو لتحصلي على ختمة.
          </p>
        </>
      )}

      <div className="mt-6 space-y-3 text-right">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--rw-muted)]">الاسم</span>
          <input
            value={props.name}
            onChange={(e) => props.setName(e.target.value)}
            required
            placeholder="اسمك"
            className="w-full rounded-xl border border-[var(--rw-line)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--rw-frame)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--rw-muted)]">رقم الجوال</span>
          <input
            value={props.phone}
            onChange={(e) => props.setPhone(e.target.value)}
            required
            inputMode="tel"
            dir="ltr"
            placeholder="+974 …"
            className="w-full rounded-xl border border-[var(--rw-line)] bg-white px-4 py-3 text-right text-sm outline-none focus:border-[var(--rw-frame)]"
          />
        </label>
      </div>

      {props.error && <p className="mt-3 text-sm text-red-500">{props.error}</p>}

      <button
        type="submit"
        disabled={props.loading}
        className="mt-5 w-full rounded-xl py-3 text-sm font-bold text-white shadow-md transition active:scale-[.99] disabled:opacity-60"
        style={{ background: "var(--rw-grad)" }}
      >
        {props.loading ? "…" : "عرض بطاقتي"}
      </button>
    </form>
  );
}

function CardView(props: {
  brand: LoyaltyBrand;
  state: RewardState;
  uploading: boolean;
  justSubmitted: boolean;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onChoosePrize: (prizeId: string) => void;
  onSwitch: () => void;
  error: string | null;
}) {
  const { state } = props;
  const hearts = Array.from({ length: state.required }, (_, i) => i < state.stamps);
  const remaining = Math.max(0, state.required - state.stamps);
  const chosen = state.prizes.find((p) => p.id === state.chosenPrizeId) ?? null;

  return (
    <div className="text-center">
      {props.brand !== "pureseoul" && (
        <h1 className="text-2xl font-bold text-[var(--rw-primary)]">بطاقة مكافآت الجمال</h1>
      )}
      <p className="mt-1 text-sm text-[var(--rw-muted)]">
        أهلاً <b className="text-[var(--rw-primary)]">{state.name}</b> {props.brand === "pureseoul" ? "🌸" : "🌷"}
      </p>

      {/* hearts */}
      <div
        className={`my-6 flex items-center justify-center ${
          props.brand === "pureseoul" ? "gap-1" : "flex-wrap gap-1.5"
        }`}
      >
        {hearts.map((filled, i) =>
          props.brand === "pureseoul" ? (
            <Stamp key={i} filled={filled} index={i} />
          ) : (
            <Heart key={i} filled={filled} index={i} />
          )
        )}
      </div>

      {state.rewardReady ? (
        <div className="rounded-2xl bg-[var(--rw-soft)] p-4">
          <p className="text-base font-bold text-[var(--rw-primary)]">🎉 مبروك! أكملتِ ختماتك</p>
          <p className="mt-1 text-sm text-[var(--rw-text)]">
            {chosen
              ? "اخترتِ جائزتك — أبرزي هذه البطاقة عند الطلب."
              : state.prizes.length
              ? "اختاري جائزتك من الأسفل 👇"
              : "اختاري أي منتج من المتجر مجاناً — أبرزي هذه البطاقة عند الطلب."}
          </p>
        </div>
      ) : (
        <p className="text-sm text-[var(--rw-text)]">
          {state.stamps === 0
            ? "ابدئي رحلتك — ارفعي صورة تقييمك في سنونو."
            : `باقي لك ${remaining} ${remaining === 1 ? "ختمة" : "ختمات"} على هديتك 💝`}
        </p>
      )}

      {/* prize voucher card — shown once she picks a prize */}
      {chosen && (
        <div
          className="mt-4 rounded-2xl border-2 border-[var(--rw-frame)] bg-white p-4 text-center"
          style={{ boxShadow: "0 12px 30px -14px rgba(180,120,90,.4)" }}
        >
          <p className="text-[11px] font-semibold tracking-[0.3em] text-[var(--rw-gold)]">🎁 بطاقة جائزتك</p>
          {chosen.imageUrl && (
            <div className="mx-auto mt-2 w-28 overflow-hidden rounded-xl border border-[var(--rw-line2)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={chosen.imageUrl} alt={chosen.name || "الجائزة"} className="aspect-square w-full object-cover" />
            </div>
          )}
          {chosen.name && <p className="mt-2 text-base font-bold text-[#1f1a17]">{chosen.name}</p>}
          {state.voucherCode && (
            <p dir="ltr" className="mt-1 text-sm font-bold tracking-wider text-[var(--rw-primary)]">
              {state.voucherCode}
            </p>
          )}
          <p className="mt-2 text-xs text-[var(--rw-muted)]">
            📩 أرسلناها لك على واتساب · أبرزيها عند الاستلام
          </p>
        </div>
      )}

      {/* pending / status feedback */}
      {props.justSubmitted && (
        <p className="mt-4 rounded-xl bg-[#fff6e9] px-3 py-2 text-sm text-[#a9791f]">
          ✅ تم استلام صورتك — بانتظار المراجعة، وبعد الاعتماد تنختم لك ختمة.
        </p>
      )}
      {!props.justSubmitted && state.pending > 0 && (
        <p className="mt-4 rounded-xl bg-[#fff6e9] px-3 py-2 text-sm text-[#a9791f]">
          ⏳ لديك {state.pending} {state.pending === 1 ? "صورة" : "صور"} بانتظار المراجعة.
        </p>
      )}
      {!props.justSubmitted && state.pending === 0 && state.lastStatus === "rejected" && (
        <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-500">
          آخر صورة لم تُعتمد. تأكدي أنها صورة تقييمك في سنونو وأعيدي الرفع.
        </p>
      )}

      {props.error && <p className="mt-3 text-sm text-red-500">{props.error}</p>}

      {/* prizes — preview of what she can win; a selectable chooser once complete */}
      {state.prizes.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-sm font-bold text-[var(--rw-primary)]">
            {state.rewardReady
              ? chosen
                ? "لتغيير جائزتك 🎁"
                : "اختاري جائزتك 🎁"
              : "جوائز تقدرين تكسبينها 🎁"}
          </p>
          {/* One swipeable row instead of a tall grid, so many prizes never
              make the card long. Scrolls sideways; snaps to each prize. */}
          <div
            dir="rtl"
            className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {state.prizes.map((p) => {
              const isChosen = p.id === state.chosenPrizeId;
              const selectable = state.rewardReady;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectable && props.onChoosePrize(p.id)}
                  className={`relative w-[30%] shrink-0 snap-start overflow-hidden rounded-xl border bg-white transition ${
                    isChosen
                      ? "border-[var(--rw-primary)] ring-2 ring-[var(--rw-primary2)]"
                      : "border-[var(--rw-line2)]"
                  } ${selectable ? "cursor-pointer active:scale-95" : "cursor-default opacity-90"}`}
                >
                  <div className="aspect-square bg-[#faf3ee]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.imageUrl} alt={p.name || "جائزة"} className="h-full w-full object-cover" />
                  </div>
                  {p.name && (
                    <p className="truncate px-1 py-1 text-[10px] font-semibold text-[var(--rw-text)]">{p.name}</p>
                  )}
                  {isChosen && (
                    <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--rw-primary)] text-[11px] text-white">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {state.prizes.length > 3 && (
            <p className="mt-1 text-[11px] text-[var(--rw-muted)]">
              ← اسحبي لتشوفي كل الجوائز ({state.prizes.length})
            </p>
          )}
          {state.rewardReady && chosen && (
            <p className="mt-2 text-xs text-[var(--rw-muted)]">
              تقدرين تغيّرين اختيارك قبل الاستلام.
            </p>
          )}
        </div>
      )}

      {/* upload — hidden once the card is complete (nothing more to collect) */}
      {!state.rewardReady && (
        <label
          className={`mt-5 block w-full cursor-pointer rounded-xl py-3 text-center text-sm font-bold text-white shadow-md transition active:scale-[.99] ${
            props.uploading ? "opacity-60" : ""
          }`}
          style={{ background: "var(--rw-grad)" }}
        >
          {props.uploading ? "جارٍ الرفع…" : "📷 رفع صورة تقييم سنونو"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={props.uploading}
            onChange={props.onUpload}
          />
        </label>
      )}

      <button
        onClick={props.onSwitch}
        className="mt-3 text-xs text-[var(--rw-faint)] underline"
      >
        رقم آخر؟ تسجيل جديد
      </button>
    </div>
  );
}
