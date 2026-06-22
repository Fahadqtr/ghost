"use client";

import { useMemo, useRef, useState, useTransition } from "react";
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
      const i = prev.findIndex((l) => l.item.inventoryId === found.inventoryId);
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

  function setLineQty(inventoryId: string, v: string) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    setLines((prev) => prev.map((l) => (l.item.inventoryId === inventoryId ? { ...l, qty: n } : l)));
  }
  function removeLine(inventoryId: string) {
    setLines((prev) => prev.filter((l) => l.item.inventoryId !== inventoryId));
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
        const res = await recordMovement({
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
                  key={it.inventoryId}
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

      {/* Cart of scanned products */}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">After</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l) => {
                const after = type === "in" ? l.item.stock + l.qty : l.item.stock - l.qty;
                return (
                  <tr key={l.item.inventoryId}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{l.item.name ?? l.item.sku}</div>
                      {l.item.name_ar && <div className="text-xs text-muted">{l.item.name_ar}</div>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{l.item.sku ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{l.item.stock}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        className="input w-20 text-right"
                        type="number"
                        min={0}
                        value={l.qty}
                        onChange={(e) => setLineQty(l.item.inventoryId, e.target.value)}
                      />
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${after < 0 ? "text-red-600" : "text-ink"}`}>{after}</td>
                    <td className="px-3 py-2 text-right">
                      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => removeLine(l.item.inventoryId)}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
