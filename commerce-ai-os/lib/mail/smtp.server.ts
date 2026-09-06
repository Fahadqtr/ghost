// MAIL — generic SMTP transport (SERVER-ONLY).
//
// A thin nodemailer wrapper over the env-driven MailConfig. Works with any
// standard SMTP provider (Titan included) purely through deployment
// environment variables — NO host, port, username, password or key is ever
// hardcoded or assumed here. When the environment is not fully configured,
// getMailConfig() returns null and every send surface stays disabled.

import "server-only";
import nodemailer from "nodemailer";
import { readMailConfig, type MailConfig } from "./config";

export interface OutboundMailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface OutboundMail {
  to: string[];
  cc: string[];
  subject: string;
  /**
   * The HTML part. Optional: a caller whose approved HTML is unavailable omits
   * it and the message goes out as plain text only, rather than shipping a
   * substituted or half-rendered body.
   */
  html?: string;
  /** plain-text MIME alternative — always present. */
  text: string;
  attachments: OutboundMailAttachment[];
}

export function getMailConfig(): MailConfig | null {
  return readMailConfig(process.env as Record<string, string | undefined>);
}

/** Transmit one message. Never retries, never mutates anything else. */
export async function sendMailViaSmtp(
  config: MailConfig,
  mail: OutboundMail,
): Promise<{ ok: true; messageId: string | null } | { ok: false; detail: string }> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
    });
    const info = await transporter.sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to: mail.to.join(", "),
      cc: mail.cc.length > 0 ? mail.cc.join(", ") : undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { ok: true, messageId: typeof info.messageId === "string" ? info.messageId : null };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "smtp send failed" };
  }
}
