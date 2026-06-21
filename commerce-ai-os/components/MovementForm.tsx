"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordMovement } from "@/app/(app)/inventory/actions";
import BarcodeScanner from "@/components/BarcodeScanner";
import PhotoIdentify from "@/components/PhotoIdentify";

export type PickItem = {
  inventoryId: string;
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  barcode: string | null;
  stock: number;
};

const REASONS: Record<"in" | "out", string[]> = {
  in: ["purchase", "return", "transfer-in", "adjustment"],
  out: ["sale", "damage", "expired", "transfer-out", "adjustment"],
};

export default function MovementForm({ items }: { items: PickItem[] }) {
  const router = useRouter();
  const [pq, setPq] = useState("");
  const [selected, setSelected] = useState<PickItem | null>(null);
  const [type, setType] = useState<"in" | "out">("in");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("purchase");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [pending, startTransition] = useTransition();

  function onScan(code: string) {
    const c = code.trim();
    setScanning(false);
    const found =
      items.find((it) => (it.barcode ?? "") === c) ||
      items.find((it) => (it.sku ?? "").toLowerCase() === c.toLowerCase());
    if (found) {
      pick(found);
      setMsg({ kind: "ok", text: `Scanned: ${found.name ?? found.sku}` });
    } else {
      setMsg({ kind: "err", text: `No product matches barcode ${c}.` });
    }
  }

  const matches = useMemo(() => {
    const n = pq.trim().toLowerCase();
    if (!n) return [];
    return items
      .filter(
        (it) =>
          (it.name ?? "").toLowerCase().includes(n) ||
          (it.sku ?? "").toLowerCase().includes(n) ||
          (it.name_ar ?? "").includes(pq.trim())
      )
      .slice(0, 8);
  }, [pq, items]);

  function pick(it: PickItem) {
    setSelected(it);
    setPq("");
  }

  function switchType(t: "in" | "out") {
    setType(t);
    if (!REASONS[t].includes(reason)) setReason(REASONS[t][0]);
  }

  function submit() {
    if (!selected) {
      setMsg({ kind: "err", text: "Pick a product first." });
      return;
    }
    const n = Math.floor(Math.abs(Number(qty)));
    if (!n) {
      setMsg({ kind: "err", text: "Enter a quantity greater than 0." });
      return;
    }
    startTransition(async () => {
      const res = await recordMovement({
        inventoryId: selected.inventoryId,
        sku: selected.sku,
        type,
        quantity: n,
        reason,
        note: note.trim() || null,
      });
      if (res && "error" in res && res.error) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      const after = (res as any).after;
      const logged = (res as any).logged !== false;
      setMsg({
        kind: "ok",
        text: `${type === "in" ? "Added" : "Removed"} ${n} × ${selected.name ?? selected.sku} · new stock: ${after}${logged ? "" : " (saved, but history log unavailable)"}`,
      });
      // reflect new stock locally + reset the entry
      setSelected({ ...selected, stock: after });
      setQty("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="card space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Product picker */}
        <div className="space-y-1">
          <label className="label">Product</label>
          {selected ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">{selected.name ?? selected.sku}</div>
                <div className="text-xs text-muted">
                  {selected.sku} · current stock <span className="font-medium text-ink">{selected.stock}</span>
                </div>
              </div>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSelected(null)}>Change</button>
            </div>
          ) : (
            <div className="relative">
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="Search product name or SKU…"
                  value={pq}
                  onChange={(e) => setPq(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-ghost flex-none px-3 py-2 text-sm"
                  onClick={() => setScanning(true)}
                  title="Scan barcode with camera"
                >
                  📷 Scan
                </button>
                <button
                  type="button"
                  className="btn-ghost flex-none px-3 py-2 text-sm"
                  onClick={() => setIdentifying(true)}
                  title="Identify product by photo (AI)"
                >
                  🔍 Photo
                </button>
              </div>
              {matches.length > 0 && (
                <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                  {matches.map((it) => (
                    <button
                      key={it.inventoryId}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => pick(it)}
                    >
                      <span className="min-w-0 truncate">{it.name ?? it.sku}</span>
                      <span className="flex-none text-xs text-muted">{it.sku} · {it.stock}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Type toggle */}
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

        {/* Quantity */}
        <div className="space-y-1">
          <label className="label">Quantity</label>
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="e.g. 50" />
        </div>

        {/* Reason */}
        <div className="space-y-1">
          <label className="label">Reason</label>
          <div className="flex flex-wrap gap-2">
            {REASONS[type].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize ${
                  reason === r
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Note */}
        <div className="space-y-1 sm:col-span-2">
          <label className="label">Note (optional)</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reference / supplier / details…" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary px-4 py-2 text-sm disabled:opacity-50" disabled={pending} onClick={submit}>
          {pending ? "Saving…" : type === "in" ? "Record stock IN" : "Record stock OUT"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.kind === "ok" ? "text-green-700" : "text-amber-700"}`}>{msg.text}</span>
        )}
      </div>

      {scanning && <BarcodeScanner onDetected={onScan} onClose={() => setScanning(false)} />}
      {identifying && (
        <PhotoIdentify
          onPick={(it) => {
            pick(it);
            setIdentifying(false);
            setMsg({ kind: "ok", text: `Selected: ${it.name ?? it.sku}` });
          }}
          onClose={() => setIdentifying(false)}
        />
      )}
    </div>
  );
}
