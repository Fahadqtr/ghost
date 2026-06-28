"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordMovement, recordVariantMovement } from "@/app/(app)/inventory/actions";
import BarcodeScanner from "@/components/BarcodeScanner";
import PhotoIdentify from "@/components/PhotoIdentify";

export type PickItem = {
  inventoryId: string;
  variantId?: string | null; // set => this pick is a specific variant (option)
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  barcode: string | null;
  image_url: string | null;
  stock: number;
};

// Stable cart identity: a variant stands on its own, else the inventory row.
// (Variants of one product share a parent inventoryId, so that can't be the key.)
const uidOf = (it: PickItem) => it.variantId ?? it.inventoryId;

type Line = { item: PickItem; qty: number };

const REASONS: Record<"in" | "out", string[]> = {
  in: ["purchase", "return", "transfer-in", "adjustment"],
  out: ["sale", "damage", "expired", "transfer-out", "adjustment"],
};

export default function MovementForm({ items }: { items: PickItem[] }) {
  const router = useRouter();
  const [pq, setPq] = useState("");
  const [lines, setLines] = useState<Line[]>([]); // most-recent first
  const [type, setType] = useState<"in" | "out">("in");
  const [reason, setReason] = useState("purchase");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [pending, startTransition] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  /** Add a scanned/picked product to the cart, or +1 if it's already there. */
  function addOrInc(found: PickItem) {
    setLines((prev) => {
      const i = prev.findIndex((l) => uidOf(l.item) === uidOf(found));
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        // bubble the just-counted line to the top
        return [next[i], ...next.slice(0, i), ...next.slice(i + 1)];
      }
      return [{ item: found, qty: 1 }, ...prev];
    });
    setPq("");
    setMsg({ kind: "ok", text: `+1 ${found.name ?? found.sku}` });
    scanRef.current?.focus();
  }

  function onScan(code: string) {
    const c = code.trim();
    setScanning(false);
    const found =
      items.find((it) => (it.barcode ?? "") === c) ||
      items.find((it) => (it.sku ?? "").toLowerCase() === c.toLowerCase());
    if (found) addOrInc(found);
    else setMsg({ kind: "err", text: `No product matches barcode ${c}.` });
  }

  const matches = useMemo(() => {
    const n = pq.trim().toLowerCase();
    if (!n) return [];
    return items
      .filter(
        (it) =>
          (it.name ?? "").toLowerCase().includes(n) ||
          (it.sku ?? "").toLowerCase().includes(n) ||
          (it.barcode ?? "").includes(pq.trim()) ||
          (it.name_ar ?? "").includes(pq.trim())
      )
      .slice(0, 8);
  }, [pq, items]);

  // Enter in the scan box (or a keyboard-wedge scanner) resolves and adds +1.
  function onProductKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const c = pq.trim();
    if (!c) return;
    const found =
      items.find((it) => (it.barcode ?? "") === c) ||
      items.find((it) => (it.sku ?? "").toLowerCase() === c.toLowerCase()) ||
      (matches.length === 1 ? matches[0] : null);
    if (found) addOrInc(found);
    else setMsg({ kind: "err", text: `No product matches “${c}”.` });
  }

  function setLineQty(uid: string, v: string) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    setLines((prev) => prev.map((l) => (uidOf(l.item) === uid ? { ...l, qty: n } : l)));
  }
  function stepQty(uid: string, d: number) {
    setLines((prev) =>
      prev.map((l) => (uidOf(l.item) === uid ? { ...l, qty: Math.max(0, l.qty + d) } : l))
    );
  }
  function removeLine(uid: string) {
    setLines((prev) => prev.filter((l) => uidOf(l.item) !== uid));
  }

  function switchType(t: "in" | "out") {
    setType(t);
    if (!REASONS[t].includes(reason)) setReason(REASONS[t][0]);
  }

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  function submit() {
    const valid = lines.filter((l) => l.qty > 0);
    if (valid.length === 0) {
      setMsg({ kind: "err", text: "Scan at least one product first." });
      return;
    }
    startTransition(async () => {
      let ok = 0;
      const errors: string[] = [];
      for (const l of valid) {
        const res = l.item.variantId
          ? await recordVariantMovement({
              variantId: l.item.variantId,
              sku: l.item.sku,
              type,
              quantity: l.qty,
              reason,
              note: note.trim() || null,
            })
          : await recordMovement({
              inventoryId: l.item.inventoryId,
              sku: l.item.sku,
              type,
              quantity: l.qty,
              reason,
              note: note.trim() || null,
            });
        if (res && "error" in res && res.error) errors.push(`${l.item.sku ?? l.item.name}: ${res.error}`);
        else ok++;
      }
      setMsg({
        kind: errors.length ? "err" : "ok",
        text: errors.length
          ? `Recorded ${ok}, ${errors.length} failed: ${errors.slice(0, 3).join("; ")}`
          : `Recorded ${type === "in" ? "IN" : "OUT"} for ${ok} product${ok === 1 ? "" : "s"} (${totalUnits} units).`,
      });
      if (!errors.length) {
        setLines([]);
        setNote("");
      }
      router.refresh();
    });
  }

  return (
    <div className="card space-y-4">
      {/* Batch settings: direction + reason apply to everything scanned below */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="label">Movement</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => switchType("in")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${type === "in" ? "border-green-300 bg-green-50 text-green-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              IN ↓ (stock entering)
            </button>
            <button
              type="button"
              onClick={() => switchType("out")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${type === "out" ? "border-orange-300 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              OUT ↑ (stock leaving)
            </button>
          </div>
        </div>
        <div className="space-y-1">
          <label className="label">Reason</label>
          <div className="flex flex-wrap gap-2">
            {REASONS[type].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize ${
                  reason === r ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scan box — add as many different products as you like */}
      <div className="space-y-1">
        <label className="label">Scan products</label>
        <div className="relative">
          <div className="flex gap-2">
            <input
              ref={scanRef}
              className="input flex-1"
              placeholder="Scan or type name / SKU / barcode, press Enter — scan again to add +1…"
              value={pq}
              onChange={(e) => setPq(e.target.value)}
              onKeyDown={onProductKeyDown}
              autoComplete="off"
            />
            <button type="button" className="btn-ghost flex-none px-3 py-2 text-sm" onClick={() => setScanning(true)} title="Scan barcode with camera">
              📷 Scan
            </button>
            <button type="button" className="btn-ghost flex-none px-3 py-2 text-sm" onClick={() => setIdentifying(true)} title="Identify product by photo (AI)">
              🔍 Photo
            </button>
          </div>
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {matches.map((it) => (
                <button
                  key={uidOf(it)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  onClick={() => addOrInc(it)}
                >
                  <span className="min-w-0 truncate">{it.name ?? it.sku}</span>
                  <span className="flex-none text-xs text-muted">{it.sku} · {it.stock}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Note */}
      <div className="space-y-1">
        <label className="label">Note (optional)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reference / supplier / details…" />
      </div>

      {/* Cart of scanned products — one card each */}
      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
          Scan a product to start your {type === "in" ? "incoming" : "outgoing"} list.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {lines.map((l) => {
            const after = type === "in" ? l.item.stock + l.qty : l.item.stock - l.qty;
            const bad = after < 0;
            return (
              <div
                key={uidOf(l.item)}
                className={`flex gap-3 rounded-xl border bg-white p-3 shadow-sm ${bad ? "border-red-200" : "border-slate-200"}`}
              >
                <div className="h-16 w-16 flex-none overflow-hidden rounded-lg bg-slate-100">
                  {l.item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.item.image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-2xl">📦</div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink">{l.item.name ?? l.item.sku}</div>
                      <div className="text-xs text-muted">{l.item.sku ?? "—"}</div>
                    </div>
                    <button
                      className="flex-none text-slate-400 hover:text-red-600"
                      title="Remove"
                      onClick={() => removeLine(uidOf(l.item))}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {/* qty stepper */}
                    <div className="flex items-center gap-1">
                      <button
                        className="h-8 w-8 rounded-lg border border-slate-200 text-lg leading-none text-slate-600 hover:bg-slate-50"
                        onClick={() => stepQty(uidOf(l.item), -1)}
                      >
                        −
                      </button>
                      <input
                        className="input h-8 w-14 text-center"
                        type="number"
                        min={0}
                        value={l.qty}
                        onChange={(e) => setLineQty(uidOf(l.item), e.target.value)}
                      />
                      <button
                        className="h-8 w-8 rounded-lg border border-slate-200 text-lg leading-none text-slate-600 hover:bg-slate-50"
                        onClick={() => stepQty(uidOf(l.item), 1)}
                      >
                        +
                      </button>
                    </div>
                    {/* stock change */}
                    <div className="text-right text-xs">
                      <span className="text-muted">{l.item.stock}</span>
                      <span className={`mx-1 ${type === "in" ? "text-green-600" : "text-orange-600"}`}>
                        {type === "in" ? "↓" : "↑"}
                      </span>
                      <span className={`font-semibold ${bad ? "text-red-600" : "text-ink"}`}>{after}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary px-4 py-2 text-sm disabled:opacity-50" disabled={pending || lines.length === 0} onClick={submit}>
          {pending ? "Saving…" : `Record ${type === "in" ? "IN" : "OUT"} · ${lines.length} product${lines.length === 1 ? "" : "s"} (${totalUnits})`}
        </button>
        {lines.length > 0 && (
          <button className="btn-ghost px-3 py-2 text-sm" disabled={pending} onClick={() => setLines([])}>Clear</button>
        )}
        {msg && <span className={`text-sm ${msg.kind === "ok" ? "text-green-700" : "text-amber-700"}`}>{msg.text}</span>}
      </div>

      {scanning && <BarcodeScanner onDetected={onScan} onClose={() => setScanning(false)} />}
      {identifying && (
        <PhotoIdentify
          onPick={(it) => {
            addOrInc(it);
            setIdentifying(false);
          }}
          onClose={() => setIdentifying(false)}
        />
      )}
    </div>
  );
}
