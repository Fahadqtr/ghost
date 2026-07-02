// Shared types + helpers for task comment threads (used by both the manager
// /tasks page and the staff /staff page). Pure — safe to import anywhere.

export type TaskComment = {
  id: string;
  author: string;      // display name (staff: prefix stripped)
  role: "staff" | "manager";
  body: string | null;
  attachmentUrl: string | null;
  attachmentType: "image" | "file" | null;
  attachmentName: string | null;
  createdAt: string | null;
};

// A comment attachment sent from the client (base64 so it survives a Server
// Action without multipart handling).
export type CommentAttachment = {
  base64: string;      // data may include the data: prefix; the server strips it
  mediaType: string;   // e.g. image/jpeg, application/pdf
  name: string;
};

export const COMMENT_BUCKET = "product-images"; // reuse the existing public bucket, under tasks/
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB
