import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export type SafeMailResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "send_failed"; error?: unknown };

export function maskEmail(email: string | undefined | null): string {
  if (!email) return "";
  const [name = "", domain = ""] = String(email).split("@");
  if (!domain) return "***";
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

export function isSmtpConfigured(): boolean {
  return Boolean(env.smtpHost && env.smtpFrom);
}

export async function sendSafeMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SafeMailResult> {
  if (!isSmtpConfigured()) {
    console.warn("[mail] SMTP not configured; skipping outbound email");
    return { ok: false, reason: "not_configured" };
  }

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser || env.smtpPass
      ? {
          user: env.smtpUser,
          pass: env.smtpPass,
        }
      : undefined,
  });

  try {
    await transporter.sendMail({
      from: env.smtpFrom,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    console.info(`[mail] sent message to ${maskEmail(input.to)}`);
    return { ok: true };
  } catch (error) {
    console.error(`[mail] failed to send message to ${maskEmail(input.to)}`);
    return { ok: false, reason: "send_failed", error };
  }
}
