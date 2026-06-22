"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyStocktake } from "@/app/(app)/inventory/actions";

export type CountItem = {
  inventoryId: string;
  barcode: string;
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  stock: number; // current system stock (expected)
};

type Line = { item: CountItem; counted: number };
type Unknown = { code: string; count: number };

/** Short audio feedback so the user can scan heads-down. */
function beep(ok: boolean) {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.value = 0.05;
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.07 : 0.22));
    osc.onended = () => ctx.close();
  } catch {
    /* audio is best-effort */
  }
}

export default function StocktakeCount({ items }: { items: CountItem[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // barcode -> item (first wins on duplicates)
  const byBarcode = useMemo(() => {
    const m = new Map<string, CountItem>();
    for (const it of items) {
      const key = it.barcode.trim();
      if (key && !m.has(key)) m.set(key, it);
    }
    return m;
  }, [items]);

  const [buf, setBuf] = useState("");
  const [lines, setLines] = useState<Line[]>([]); // most-recent first
  const [unknown, setUnknown] = useState<Unknown[]>([]);
  const [last, setLast] = useState<{ name: string; counted: number; ok: boolean } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function scan(raw: string) {
    const code = raw.trim();
    if (!code) return;
    const item = byBarcode.get(code);
    if (!item) {
      beep(false);
      setUnknown((u) => {
        const i = u.findIndex((x) => x.code === code);
        if (i >= 0) {
          const n = [...u];
          n[i] = { ...n[i], count: n[i].count + 1 };
          return n;
        }
        return [{ code, count: 1 }, ...u];
      });
      setLast({ name: `Unknown barcode ${code}`, counted: 0, ok: false });
      return;
    }
    beep(true);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.item.inventoryId === item.inventoryId);
      let counted = 1;
      let next: Line[];
      if (i >= 0) {
        counted = prev[i].counted + 1;
        next = [{ item, counted }, ...prev.slice(0, i), ...prev.slice(i + 1)];
      } else {
        next = [{ item, counted: 1 }, ...prev];
      }
      setLast({ name: item.name ?? item.sku ?? code, counted, ok: true });
      return next;
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    scan(buf);
    setBuf("");
    inputRef.current?.focus();
  }

  function setCounted(inventoryId: string, v: string) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    setLines((prev) => prev.map((l) => (l.item.inventoryId === inventoryId ? { ...l, counted: n } : l)));
  }
  function removeLine(inventoryId: string) {
    setLines((prev) => prev.filter((l) => l.item.inventoryId !== inventoryId));
  }
  function clearAll() {
    if (lines.length && !confirm("Clear the whole count session?")) return;
    setLines([]);
    setUnknown([]);
    setLast(null);
    setMsg(null);
    inputRef.current?.focus();
  }

  const totalUnits = lines.reduce((s, l) => s + l.counted, 0);
  const variances = lines.filter((l) => l.counted !== l.item.stock).length;

  function apply() {
    if (lines.length === 0) return;
    const counts = lines.map((l) => ({ inventoryId: l.item.inventoryId, sku: l.item.sku, counted: l.counted }));
    startTransition(async () => {
      const res = await applyStocktake(counts);
      setMsg({
        kind: res.failed ? "err" : "ok",
        text: res.failed
          ? `Applied ${res.ok}, ${res.failed} failed: ${res.errors.join("; ")}`
          : `Applied ${res.ok} count${res.ok === 1 ? "" : "s"} to inventory.`,
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Scan box */}
      <form onSubmit={onSubmit} className="card space-y-3">
        <label className="text-sm font-medium text-ink">Scan items on the shelf</label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            autoFocus
            className="input flex-1 text-lg"
            placeholder="Scan a barcode (or type it) and press Enter…"
            value={buf}
            onChange={(e) => setBuf(e.target.value)}
            onBlur={() => setTimeout(() => inputRef.current?.focus(), 50)}
            // keep the field hot for a hardware scanner (keyboard wedge)
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="btn-primary px-4">Add</button>
        </div>
        {last && (
          <div className={`text-sm ${last.ok ? "text-green-700" : "text-amber-700"}`}>
            {last.ok ? `✓ ${last.name} — counted ${last.counted}` : `⚠ ${last.name}`}
          </div>
        )}
        <p className="text-xs text-muted">
          Hold your USB/Bluetooth scanner and scan each piece — every scan adds <b>+1</b>. Keep this box focused.
          You can also edit any count by hand below.
        </p>
      </form>

      {/* Summary + actions */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-muted">{lines.length} item{lines.length === 1 ? "" : "s"}</span>
        <span className="text-muted">{totalUnits} unit{totalUnits === 1 ? "" : "s"} counted</span>
        {variances > 0 && <span className="font-medium text-amber-700">{variances} with variance</span>}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost px-3 py-1 text-xs" onClick={clearAll} disabled={lines.length === 0 && unknown.length === 0}>
            Clear
          </button>
          <button
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50"
            onClick={apply}
            disabled={lines.length === 0 || pending}
          >
            {pending ? "Applying…" : "Apply counts to inventory"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`card py-2 text-sm ${msg.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {msg.text}
          <button className="ml-3 text-xs underline" onClick={() => setMsg(null)}>dismiss</button>
        </div>
      )}

      {/* Unknown barcodes */}
      {unknown.length > 0 && (
        <div className="card border-amber-200 bg-amber-50 py-3 text-sm text-amber-800">
          <div className="mb-1 font-medium">Unrecognised barcodes (not in catalog):</div>
          <div className="flex flex-wrap gap-2">
            {unknown.map((u) => (
              <span key={u.code} className="rounded bg-white px-2 py-0.5 font-mono text-xs">
                {u.code}{u.count > 1 ? ` ×${u.count}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Count table */}
      {lines.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3 text-right">Counted</th>
                <th className="px-4 py-3 text-right">System</th>
                <th className="px-4 py-3 text-right">Diff</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const diff = l.counted - l.item.stock;
                const diffCls = diff === 0 ? "text-slate-400" : diff > 0 ? "text-green-700" : "text-red-700";
                return (
                  <tr key={l.item.inventoryId} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{l.item.name ?? "—"}</div>
                      {l.item.name_ar ? <div className="text-xs text-muted" dir="rtl">{l.item.name_ar}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{l.item.sku ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <input
                        className="input w-20 text-right"
                        type="number"
                        min={0}
                        value={l.counted}
                        onChange={(e) => setCounted(l.item.inventoryId, e.target.value)}
                      />
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">{l.item.stock}</td>
                    <td className={`px-4 py-3 text-right font-medium ${diffCls}`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => removeLine(l.item.inventoryId)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
