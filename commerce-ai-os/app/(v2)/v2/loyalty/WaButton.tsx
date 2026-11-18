// Opens WhatsApp (app or web) with a ready-made message for one customer.
// A plain link — no server call — so it works even when the automatic
// WhatsApp sender isn't configured.
export default function WaButton({
  href,
  label,
  variant = "solid",
}: {
  href: string | null;
  label: string;
  variant?: "solid" | "outline";
}) {
  if (!href) {
    return (
      <span className="rounded-lg border border-slate-200 px-3 py-1.5 text-center text-xs text-slate-400">
        لا يوجد رقم صالح
      </span>
    );
  }
  const cls =
    variant === "solid"
      ? "bg-emerald-600 text-white hover:bg-emerald-700"
      : "border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`rounded-lg px-3 py-1.5 text-center text-xs font-bold ${cls}`}
    >
      {label}
    </a>
  );
}
