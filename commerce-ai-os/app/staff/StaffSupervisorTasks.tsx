"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  staffAllTasks, staffCreateTask, staffAssignTask, staffSuperviseSetStatus,
  staffTaskComments, staffAddTaskComment, staffOutOfStock, staffOpenStockTask, staffFindForRestock, staffCreatePhotoTask,
  type SupervisorTask, type StaffMemberLite, type OosProduct, type RestockCandidate,
} from "./actions";
import CatalogTaskDetails from "@/components/CatalogTaskDetails";
import TaskThread from "@/components/TaskThread";
import { prepareImage } from "@/lib/imagePrep";
import { type Locale } from "@/lib/i18n";

// Supervisor view inside the staff Tasks tab (gated by "manage_tasks"):
// every task — including unassigned catalog cards — with assign, follow-up,
// status control and a quick create form. A staff-portal sibling of /tasks.

export default function StaffSupervisorTasks({ locale }: { locale: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [tasks, setTasks] = useState<SupervisorTask[]>([]);
  const [members, setMembers] = useState<StaffMemberLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [whoFilter, setWhoFilter] = useState(""); // "" all · "none" unassigned · member id
  const [oosItems, setOosItems] = useState<OosProduct[] | null>(null); // null = not scanned yet
  const [restockQ, setRestockQ] = useState("");
  const [restockItems, setRestockItems] = useState<RestockCandidate[] | null>(null);
  const [photo, setPhoto] = useState<{ base64: string; mediaType: string; dataUrl: string } | null>(null);
  const [photoAssign, setPhotoAssign] = useState("");
  const [photoNote, setPhotoNote] = useState("");
  const [photoPrice, setPhotoPrice] = useState("");
  const [photoOk, setPhotoOk] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", assignedTo: "", priority: "normal", dueDate: "" });
  const [busy, start] = useTransition();

  const reload = () => start(async () => {
    const r = await staffAllTasks();
    if (r.error) setErr(r.error);
    setTasks(r.tasks); setMembers(r.members); setLoading(false);
  });
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openT = tasks.filter((t) => t.status !== "done");
  const doneT = tasks.filter((t) => t.status === "done");
  const unassignedN = openT.filter((t) => !t.assignedTo).length;

  // Per-employee open/done counts for the follow-up strip.
  const perMember = useMemo(() => members.map((m) => ({
    ...m,
    open: openT.filter((t) => t.assignedTo === m.id).length,
    done: doneT.filter((t) => t.assignedTo === m.id).length,
  })), [members, openT, doneT]);

  const visible = openT.filter((t) =>
    !whoFilter ? true : whoFilter === "none" ? !t.assignedTo : t.assignedTo === whoFilter);

  const assign = (t: SupervisorTask, staffId: string) => start(async () => {
    const r = await staffAssignTask(t.id, staffId || null);
    if ("error" in r) { setErr(r.error); return; }
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, assignedTo: staffId || null, assignedName: r.assignedName, forEveryone: !staffId } : x)));
  });

  const setStatus = (id: string, status: "open" | "in_progress" | "done") => start(async () => {
    const r = await staffSuperviseSetStatus(id, status);
    if ("error" in r) { setErr(r.error); return; }
    setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, status } : x)));
  });

  const scanOos = () => start(async () => {
    const r = await staffOutOfStock();
    if (r.error) { setErr(r.error); return; }
    setOosItems(r.items);
  });

  const openOos = (id: string) => start(async () => {
    const r = await staffOpenStockTask(id, "oos");
    if ("error" in r) { setErr(r.error); return; }
    setOosItems((items) => items?.map((i) => (i.id === id ? { ...i, hasOpenTask: true } : i)) ?? null);
    reload(); // the new task appears in the list below
  });

  const openAllOos = () => start(async () => {
    const targets = (oosItems ?? []).filter((i) => !i.hasOpenTask);
    for (const t of targets) {
      const r = await staffOpenStockTask(t.id, "oos");
      if ("error" in r) { setErr(r.error); break; }
      setOosItems((items) => items?.map((i) => (i.id === t.id ? { ...i, hasOpenTask: true } : i)) ?? null);
    }
    reload();
  });

  const searchRestock = () => start(async () => {
    const r = await staffFindForRestock(restockQ);
    if (r.error) { setErr(r.error); return; }
    setRestockItems(r.items);
  });

  const openRestock = (id: string) => start(async () => {
    const r = await staffOpenStockTask(id, "restock");
    if ("error" in r) { setErr(r.error); return; }
    setRestockItems((items) => items?.map((i) => (i.id === id ? { ...i, hasOpenTask: true } : i)) ?? null);
    reload();
  });

  const onPhotoFile = (file: File) => {
    setErr(""); setPhotoOk("");
    start(async () => {
      try {
        const p = await prepareImage(file);
        setPhoto({ base64: p.base64, mediaType: p.mediaType, dataUrl: p.dataUrl });
      } catch {
        setErr(L("تعذّر معالجة الصورة — جرّب صورة ثانية.", "Couldn't process the photo — try another one."));
      }
    });
  };

  const sendPhotoTask = () => {
    if (!photo) return;
    setErr(""); setPhotoOk("");
    start(async () => {
      const r = await staffCreatePhotoTask({ base64: photo.base64, mediaType: photo.mediaType, assignedTo: photoAssign || null, note: photoNote, price: photoPrice });
      if ("error" in r) { setErr(r.error); return; }
      const name = members.find((m) => m.id === photoAssign)?.name;
      setPhoto(null); setPhotoNote(""); setPhotoAssign(""); setPhotoPrice("");
      setPhotoOk(name ? L(`✓ انفتحت المهمة وانحوّلت إلى ${name}.`, `✓ Task opened and assigned to ${name}.`) : L("✓ انفتحت المهمة (للكل).", "✓ Task opened (everyone)."));
      reload();
    });
  };

  const create = () => {
    setErr("");
    start(async () => {
      const r = await staffCreateTask({
        title: form.title, description: form.description,
        assignedTo: form.assignedTo || null,
        priority: form.priority as "low" | "normal" | "high",
        dueDate: form.dueDate || null,
      });
      if ("error" in r) { setErr(r.error); return; }
      setForm({ title: "", description: "", assignedTo: "", priority: "normal", dueDate: "" });
      setShowForm(false);
      reload();
    });
  };

  const dot = (p: string) => (p === "high" ? "🔴" : p === "low" ? "⚪" : "🟡");
  const bar = (p: string) => (p === "high" ? "bg-red-500" : p === "low" ? "bg-slate-300" : "bg-amber-400");
  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(locale, { day: "2-digit", month: "short" });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      {err ? <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      {/* follow-up strip: per-employee load + the triage queue */}
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setWhoFilter("")}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${!whoFilter ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>
          {L("الكل", "All")} ({openT.length})
        </button>
        <button onClick={() => setWhoFilter("none")}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${whoFilter === "none" ? "bg-violet-600 text-white" : unassignedN > 0 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>
          ⏳ {L("بانتظار التوجيه", "Unassigned")} ({unassignedN})
        </button>
        {perMember.map((m) => (
          <button key={m.id} onClick={() => setWhoFilter(m.id)}
            className={`rounded-full px-3 py-1.5 text-xs ${whoFilter === m.id ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>
            {m.name} · {m.open}{m.done ? ` ✓${m.done}` : ""}
          </button>
        ))}
      </div>

      {/* out-of-stock review: which sold-out products still need the platforms flipped */}
      <div className="rounded-xl border border-red-100 bg-red-50/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-red-800">🚫 {L("المنتجات المخلّصة", "Out of stock")}{oosItems ? ` (${oosItems.length})` : ""}</p>
          <button disabled={busy} onClick={scanOos} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50">
            {busy && oosItems === null ? "…" : oosItems === null ? L("🔍 افحص", "🔍 Scan") : L("↻ حدّث", "↻ Refresh")}
          </button>
        </div>
        {oosItems === null ? (
          <p className="mt-1 text-[11px] text-red-700/70">{L("يعرض المنتجات المعتمدة اللي مخزونها صفر ويفتح مهام «علّمه غير متوفر» للموظفين.", "Lists Approved products at zero stock and opens the mark-unavailable tasks.")}</p>
        ) : oosItems.length === 0 ? (
          <p className="mt-2 text-sm text-emerald-700">✓ {L("ما فيه منتجات مخلّصة 🎉", "Nothing is out of stock 🎉")}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {oosItems.some((i) => !i.hasOpenTask) ? (
              <button disabled={busy} onClick={openAllOos} className="w-full rounded-lg bg-red-600 py-2 text-xs font-bold text-white disabled:opacity-50">
                {L(`📋 افتح مهمة لكل منتج بدون مهمة (${oosItems.filter((i) => !i.hasOpenTask).length})`, `📋 Open a task for each one missing it (${oosItems.filter((i) => !i.hasOpenTask).length})`)}
              </button>
            ) : (
              <p className="text-[11px] font-medium text-emerald-700">✓ {L("كلها لها مهام مفتوحة.", "All have open tasks.")}</p>
            )}
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {oosItems.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-lg border border-red-100 bg-white px-2 py-1.5">
                  <span className="block h-9 w-9 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image} alt="" width={36} height={36} loading="lazy" className="block h-9 w-9 object-cover" />
                    ) : <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{p.name ?? p.sku ?? "—"}</span>
                    {p.sku ? <span className="block font-mono text-[10px] text-muted">{p.sku}</span> : null}
                  </span>
                  {p.hasOpenTask ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✓ {L("لها مهمة", "Has task")}</span>
                  ) : (
                    <button disabled={busy} onClick={() => openOos(p.id)} className="shrink-0 rounded-md bg-red-600 px-2 py-1 text-[10px] font-bold text-white disabled:opacity-50">
                      {L("📋 افتح مهمة", "📋 Open task")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* new product from a photo → an employee cleans it up and adds it */}
      <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3">
        <p className="text-sm font-bold text-violet-800">📸 {L("منتج جديد من صورة", "New product from a photo")}</p>
        <p className="mt-0.5 text-[11px] text-violet-700/70">{L("صوّر المنتج وحوّله لموظف — يعدّل الصورة بالذكاء ويضيفه للكتالوج.", "Photograph it and hand it to an employee — they AI-fix the photo and add it to the catalog.")}</p>
        {photoOk ? <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">{photoOk}</p> : null}
        <div className="mt-2 space-y-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-violet-200 bg-white p-2.5">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo.dataUrl} alt="" className="h-14 w-14 rounded-lg border border-slate-200 object-cover" />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-violet-100 text-2xl">📸</span>
            )}
            <span className="min-w-0 flex-1 text-xs font-medium text-violet-700">
              {photo ? L("✓ الصورة جاهزة — اضغط لتبديلها", "✓ Photo ready — tap to replace") : L("صوّر المنتج أو ارفع صورة", "Photograph the product or upload")}
            </span>
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhotoFile(f); e.target.value = ""; }} />
          </label>
          {photo ? (
            <>
              <div className="flex gap-2">
                <select className="input flex-1 text-sm" value={photoAssign} onChange={(e) => setPhotoAssign(e.target.value)}>
                  <option value="">{L("👥 للكل", "👥 Everyone")}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <input className="input w-28 text-sm" inputMode="decimal" value={photoPrice} onChange={(e) => setPhotoPrice(e.target.value)}
                  placeholder={L("السعر ر.ق", "Price QAR")} />
              </div>
              <input className="input w-full text-sm" value={photoNote} onChange={(e) => setPhotoNote(e.target.value)}
                placeholder={L("ملاحظة (اختياري)…", "Note (optional)…")} />
              <button disabled={busy} onClick={sendPhotoTask} className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                {busy ? "…" : L("➕ افتح المهمة وحوّلها", "➕ Open & assign the task")}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* back-in-stock: search a product and open the "re-enable on the platforms" task */}
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
        <p className="text-sm font-bold text-emerald-800">🔄 {L("رجع المخزون", "Back in stock")}</p>
        <p className="mt-0.5 text-[11px] text-emerald-700/70">{L("منتج رجع له مخزون والمنصات لسا معلّمته غير متوفر؟ دوّره وافتح مهمة «فعّله».", "A product is back but the platforms still show it unavailable? Find it and open the re-enable task.")}</p>
        <form onSubmit={(e) => { e.preventDefault(); searchRestock(); }} className="mt-2 flex gap-2">
          <input value={restockQ} onChange={(e) => setRestockQ(e.target.value)} className="input flex-1 text-sm"
            placeholder={L("اسم أو كود أو باركود…", "Name / SKU / barcode…")} />
          <button type="submit" disabled={busy || !restockQ.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{L("بحث", "Search")}</button>
        </form>
        {restockItems !== null ? (
          restockItems.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">{L("ما لقيت منتج معتمد مطابق.", "No matching Approved product.")}</p>
          ) : (
            <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
              {restockItems.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-white px-2 py-1.5">
                  <span className="block h-9 w-9 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image} alt="" width={36} height={36} loading="lazy" className="block h-9 w-9 object-cover" />
                    ) : <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{p.name ?? p.sku ?? "—"}</span>
                    <span className="block text-[10px] text-muted">{p.sku ? <span className="font-mono">{p.sku} · </span> : null}{L("المخزون", "stock")} <b className={p.stock > 0 ? "text-emerald-700" : "text-red-600"}>{p.stock}</b></span>
                  </span>
                  {p.hasOpenTask ? (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✓ {L("لها مهمة", "Has task")}</span>
                  ) : p.stock > 0 ? (
                    <button disabled={busy} onClick={() => openRestock(p.id)} className="shrink-0 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white disabled:opacity-50">
                      {L("📋 افتح مهمة «فعّله»", "📋 Open re-enable task")}
                    </button>
                  ) : (
                    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">{L("لسا صفر", "Still 0")}</span>
                  )}
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>

      {/* quick create */}
      {showForm ? (
        <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3">
          <input className="input w-full" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder={L("عنوان المهمة…", "Task title…")} autoFocus />
          <textarea className="input w-full" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder={L("تفاصيل (اختياري)…", "Details (optional)…")} />
          <div className="grid grid-cols-3 gap-2">
            <select className="input text-sm" value={form.assignedTo} onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}>
              <option value="">{L("👥 للكل", "👥 Everyone")}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select className="input text-sm" value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
              <option value="low">{L("⚪ عادية", "⚪ Low")}</option>
              <option value="normal">{L("🟡 متوسطة", "🟡 Normal")}</option>
              <option value="high">{L("🔴 مهمة", "🔴 High")}</option>
            </select>
            <input type="date" className="input text-sm" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <button disabled={busy || !form.title.trim()} onClick={create} className="btn-primary flex-1 py-2 text-sm disabled:opacity-50">{busy ? "…" : L("➕ افتح المهمة", "➕ Create task")}</button>
            <button onClick={() => setShowForm(false)} className="rounded-lg border border-slate-200 px-4 text-sm text-slate-600">{L("إلغاء", "Cancel")}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} className="w-full rounded-xl border-2 border-dashed border-violet-200 py-2.5 text-sm font-medium text-violet-700">
          ➕ {L("مهمة جديدة لموظف", "New task for an employee")}
        </button>
      )}

      {loading ? <p className="text-center text-xs text-slate-400">{L("جاري التحميل…", "Loading…")}</p> : null}
      {!loading && visible.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">{L("ما فيه مهام مفتوحة هنا 🎉", "No open tasks here 🎉")}</p> : null}

      <div className="space-y-2.5">
        {visible.map((t) => (
          <div key={t.id} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 ps-4">
            <span className={`absolute inset-y-0 inset-s-0 w-1.5 ${bar(t.priority)}`} />
            <p className="text-sm font-semibold text-ink">{dot(t.priority)} {t.title}</p>
            {t.kind === "catalog" && t.payload ? (
              <CatalogTaskDetails payload={t.payload} />
            ) : t.description ? (
              <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{t.description}</p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              {t.assignedName ? (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 font-bold text-violet-700">👤 {t.assignedName}</span>
              ) : t.kind === "catalog" ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-800">⏳ {L("بانتظار التوجيه", "Needs assignment")}</span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">👥 {L("للكل", "Everyone")}</span>
              )}
              {t.dueDate ? <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-muted">⏰ {fmt(t.dueDate)}</span> : null}
              {t.status === "in_progress" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-700">⏳ {L("جاري", "In progress")}</span> : null}
              {t.createdBy ? <span className="text-slate-400">{t.createdBy}</span> : null}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <select value={t.assignedTo ?? ""} onChange={(e) => assign(t, e.target.value)} disabled={busy}
                className="input flex-1 py-1.5 text-xs">
                <option value="">{L("حوّلها إلى… (الكل)", "Assign to… (everyone)")}</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {t.status !== "in_progress" ? (
                <button disabled={busy} onClick={() => setStatus(t.id, "in_progress")} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 disabled:opacity-50">▶ {L("جاري", "Start")}</button>
              ) : null}
              <button disabled={busy} onClick={() => setStatus(t.id, "done")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">✓ {L("تم", "Done")}</button>
            </div>
            <TaskThread taskId={t.id} locale={locale} load={staffTaskComments} add={staffAddTaskComment} />
          </div>
        ))}
      </div>

      {doneT.length > 0 ? (
        <details className="pt-1">
          <summary className="cursor-pointer text-xs font-semibold text-muted">{L("منجزة", "Done")} ({doneT.length})</summary>
          <div className="mt-1.5 space-y-1.5">
            {doneT.slice(0, 30).map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-400 line-through">✓ {t.title}</span>
                {t.completedBy ? <span className="shrink-0 text-[10px] text-slate-400">{t.completedBy.replace(/^staff:/, "")}</span> : null}
                <button disabled={busy} onClick={() => setStatus(t.id, "open")} className="shrink-0 text-[11px] text-slate-500 hover:underline">↺ {L("إعادة فتح", "Reopen")}</button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
