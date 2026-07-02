import "server-only";
import crypto from "crypto";
import { COMMENT_BUCKET, MAX_ATTACHMENT_BYTES, type TaskComment, type CommentAttachment } from "./comments";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function extOf(mediaType: string, name: string): string {
  return EXT[mediaType.toLowerCase()] || (name.includes(".") ? name.split(".").pop()!.slice(0, 5) : "bin");
}

// Upload a comment attachment to storage; returns its public URL + kind.
export async function uploadCommentAttachment(admin: any, taskId: string, a: CommentAttachment):
  Promise<{ url: string; type: "image" | "file"; name: string } | { error: string }> {
  const mt = String(a.mediaType || "").toLowerCase();
  const raw = String(a.base64 || "").replace(/^data:[^,]+,/, "");
  if (!raw) return { error: "الملف فارغ." };
  let buf: Buffer;
  try { buf = Buffer.from(raw, "base64"); } catch { return { error: "الملف غير صالح." }; }
  if (!buf.length) return { error: "الملف فارغ." };
  if (buf.length > MAX_ATTACHMENT_BYTES) return { error: "الملف كبير جدًا (الحد 15 ميغابايت)." };

  const ext = extOf(mt, a.name || "");
  const path = `tasks/${taskId}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const up = await admin.storage.from(COMMENT_BUCKET).upload(path, buf, { contentType: mt || "application/octet-stream", upsert: false });
  if (up.error) return { error: `تعذّر رفع الملف: ${up.error.message}` };
  const url = admin.storage.from(COMMENT_BUCKET).getPublicUrl(path).data.publicUrl;
  return { url, type: mt.startsWith("image/") ? "image" : "file", name: String(a.name || "").slice(0, 120) || `file.${ext}` };
}

function mapComment(r: any): TaskComment {
  return {
    id: String(r.id),
    author: String(r.author ?? "").replace(/^staff:/, ""),
    role: r.role === "manager" ? "manager" : "staff",
    body: r.body ?? null,
    attachmentUrl: r.attachment_url ?? null,
    attachmentType: r.attachment_type === "image" ? "image" : r.attachment_type === "file" ? "file" : null,
    attachmentName: r.attachment_name ?? null,
    createdAt: r.created_at ?? null,
  };
}

export async function listComments(admin: any, taskId: string): Promise<TaskComment[]> {
  const { data, error } = await admin
    .from("task_comments")
    .select("id, author, role, body, attachment_url, attachment_type, attachment_name, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return [];
  return (data ?? []).map(mapComment);
}

// Insert a comment (with optional already-uploaded attachment fields).
export async function insertComment(admin: any, input: {
  taskId: string; role: "staff" | "manager"; author: string; body: string;
  attachment?: { url: string; type: "image" | "file"; name: string } | null;
}): Promise<{ ok: true } | { error: string }> {
  const body = String(input.body || "").trim().slice(0, 2000);
  if (!body && !input.attachment) return { error: "اكتب تعليقًا أو أرفق ملفًا." };
  const { error } = await admin.from("task_comments").insert({
    task_id: input.taskId,
    role: input.role,
    author: input.author,
    body: body || null,
    attachment_url: input.attachment?.url ?? null,
    attachment_type: input.attachment?.type ?? null,
    attachment_name: input.attachment?.name ?? null,
  });
  if (error) {
    if ((error as any).code === "42P01") return { error: "جدول التعليقات غير موجود — شغّل supabase/task_comments.sql." };
    return { error: error.message };
  }
  return { ok: true };
}
