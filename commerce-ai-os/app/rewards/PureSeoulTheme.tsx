// Pure Seoul look for the public rewards card, matching the store's printed
// card: pink satin, a copper/gold frame with cherry-blossom corners, crimson
// type and blossom stamps. The top (logo, title, tagline) and bottom (corners,
// three promises) are cut from that artwork (public/loyalty/pureseoul/*); the
// middle is drawn in CSS so the card can grow with its content, with the side
// frame lines placed where the artwork draws them.
//
// Artwork geometry (source 1055px wide): left line x≈17–26, right x≈1029–1038.

const LEFT_LINE = "linear-gradient(90deg,#f0b294 0%,#d23a08 22%,#f2a06a 42%,#fff8ee 62%,#f7c6c2 100%)";
const RIGHT_LINE = "linear-gradient(90deg,#fff3e2 0%,#f3c771 30%,#c58424 58%,#a4500a 80%,#e6ab8a 100%)";

export function PureSeoulFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative overflow-hidden rounded-[22px] shadow-xl"
      style={{
        background:
          "linear-gradient(115deg,rgba(255,255,255,.0) 30%,rgba(255,255,255,.45) 45%,rgba(255,255,255,0) 60%)," +
          "linear-gradient(180deg,#fcf3f6 0%,#fbdfe7 45%,#fbe2e9 100%)",
        boxShadow: "0 24px 50px -24px rgba(168,15,57,.35)",
      }}
    >
      {/* frame side lines, continuing the artwork's lines between header and footer */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: "1.61%", width: "0.9%", background: LEFT_LINE }} />
      <span aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: "97.5%", width: "0.9%", background: RIGHT_LINE }} />

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/loyalty/pureseoul/header.webp"
        alt="Pure Seoul K-Beauty — بطاقة مكافآت الجمال"
        width={1055}
        height={436}
        className="relative block h-auto w-full select-none"
        draggable={false}
      />
      {/* gold divider with a heart, as on the printed card */}
      <div aria-hidden className="relative mt-1 mb-3 flex items-center justify-center gap-2 px-[22%]">
        <span className="h-px flex-1" style={{ background: "linear-gradient(90deg,transparent,#c99a3e)" }} />
        <span className="text-sm leading-none text-[#b3123f]">❤</span>
        <span className="h-px flex-1" style={{ background: "linear-gradient(90deg,#c99a3e,transparent)" }} />
      </div>
      <div className="relative px-[9%] pb-1">{children}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/loyalty/pureseoul/footer.webp"
        alt="كل زيارة تقربك من هديتك · جمالك يستحق التميز · شكراً لثقتك بنا"
        width={1055}
        height={410}
        className="relative block h-auto w-full select-none pointer-events-none"
        draggable={false}
      />
    </div>
  );
}

/** One blossom stamp: full colour when earned, faded when still to collect. */
export function Stamp({ filled, index }: { filled: boolean; index: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/loyalty/pureseoul/stamp.webp"
      alt={filled ? "ختمة" : "ختمة متبقية"}
      width={124}
      height={124}
      className="h-10 w-10 rounded-full sm:h-11 sm:w-11"
      style={
        filled
          ? { animation: `heartPop 0.45s ease-out ${index * 0.06}s both` }
          : { filter: "grayscale(.85)", opacity: 0.35 }
      }
    />
  );
}

/** The register-view pitch, worded like the printed card. */
export function PureSeoulPromise() {
  return (
    <div>
      <p className="text-lg font-bold leading-relaxed text-[#3f2a31]">
        اجمعي <span className="text-xl text-[#a80f39]">6</span> ختمات،
        <br />
        ويمكنك اختيار أي منتج من المتجر مجاناً
      </p>
      <div className="my-4 flex items-center justify-center gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <Stamp key={i} filled index={i} />
        ))}
      </div>
      <p className="mx-auto inline-block rounded-full bg-[#a80f39] px-5 py-1.5 text-sm font-bold text-white shadow">
        سجّلي بياناتك
      </p>
      <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-[#3f2a31]">
        وارفقي صورة تقييمك في سنونو، واجمعي <b className="text-[#a80f39]">6</b> ختمات = هدية 🎁
      </p>
    </div>
  );
}
