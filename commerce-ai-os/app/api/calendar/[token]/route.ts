import { createAdminClient } from "@/lib/supabase/admin";
import { buildTaskIcs, type IcsTask } from "@/lib/tasks/ics-compute";

// Private iCalendar (.ics) feed of the staff tasks — subscribe to it from
// TickTick (Settings → Calendar → Subscribe → URL), Google/Apple Calendar, etc.
// The URL carries an unguessable token (env TASKS_ICS_TOKEN) instead of a login,
// because calendar apps fetch it without auth headers. Read-only, service-role.
//   URL:  https://<app>/api/calendar/<TASKS_ICS_TOKEN>
//   ?all=1  → include completed tasks too (default: open tasks only)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, ""); }

// Constant-time-ish token compare.
function tokenOk(given: string): boolean {
  const want = clean(process.env.TASKS_ICS_TOKEN);
  if (!want || !given) return false;
  if (given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// Stamp without Date formatting helpers that could vary: build YYYYMMDDTHHMMSSZ.
function icsStampNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!tokenOk(String(token || ""))) return new Response("Not found", { status: 404 });

  const openOnly = new URL(req.url).searchParams.get("all") !== "1";

  let tasks: IcsTask[] = [];
  try {
    const admin = createAdminClient();
    let q = admin
      .from("staff_tasks")
      .select("id, title, description, assigned_name, priority, due_date, status")
      .not("due_date", "is", null)
      .limit(2000);
    if (openOnly) q = q.neq("status", "done");
    const { data, error } = await q;
    if (error) {
      // Table not migrated / column missing → still return a valid empty calendar.
      console.error("[tasks.ics] read", error.message);
    } else {
      tasks = (data ?? []).map((r: any): IcsTask => ({
        id: String(r.id), title: r.title ?? "", description: r.description ?? null,
        assignedName: r.assigned_name ?? null, priority: r.priority ?? "normal",
        dueDate: r.due_date ?? null, status: r.status ?? "open",
      }));
    }
  } catch (e: any) {
    console.error("[tasks.ics] threw", e?.message || e);
  }

  const ics = buildTaskIcs(tasks, { stamp: icsStampNow(), calName: "Malika — المهام", openOnly });
  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="malika-tasks.ics"',
      "Cache-Control": "no-store",
    },
  });
}
