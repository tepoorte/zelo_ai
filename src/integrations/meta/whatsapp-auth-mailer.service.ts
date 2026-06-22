import { sendSafeMail } from "../../services/mail.service.js";

const ZELO_CONTACTS = [
  "079 604 99 01",
  "public-contact-006@example.invalid",
  "public-contact-003@example.invalid",
  "+41 00 000 00 02",
];

const ZELO_LOGO_SVG = `
<svg width="150" height="66" viewBox="0 0 283.91 125.36" role="img" aria-label="Zélo" xmlns="http://www.w3.org/2000/svg">
  <path fill="#5CB135" d="M230.82,23.06c-24.77,0-44.93,20.15-44.93,44.92c0,13.69,6.17,25.95,15.86,34.19H32.78 l44.65-73.62v-2.98H13.62v10.73h43.94l-44.53,73.63v2.98h215.11v-0.14c0.9,0.05,1.79,0.14,2.7,0.14c32.73,0,44.92-27.55,44.92-44.92 C275.74,43.22,255.59,23.06,230.82,23.06z M230.82,102.08c-18.8,0-34.09-15.29-34.09-34.09s15.29-34.09,34.09-34.09 c18.8,0,34.09,15.29,34.09,34.09C264.91,77.47,258.79,102.08,230.82,102.08z M238.26,67.99c0,4.1-3.34,7.43-7.44,7.43 c-4.1,0-7.43-3.34-7.43-7.43c0-4.1,3.34-7.44,7.43-7.44C234.92,60.55,238.26,63.89,238.26,67.99z"/>
  <path fill="#2A2A2A" d="M153.27,73.92V5.45h11.33v66.56c0,3.42,0.98,6.11,2.95,8.08c1.97,1.97,4.54,2.95,7.72,2.95v10.13 C160.6,93.17,153.27,86.76,153.27,73.92z M126.51,5.99h-12.56l-10.77,12.87h8.93L126.51,5.99z M88.13,85.01 c-6.67-6-10.01-14.07-10.01-24.2c0-10.53,3.42-18.98,10.26-25.34c6.12-5.68,13.37-8.52,21.74-8.52c9.73,0,17.36,2.56,22.89,7.69 c5.36,4.93,8.03,11.47,8.03,19.61c0,2.51-0.32,4.81-0.96,6.92H90.87c0,7.47,2.19,13.22,6.57,17.23c3.87,3.5,8.84,5.25,14.92,5.25 c6.93,0,12.71-1.89,17.34-5.66l5.1,8.17c-1.87,1.75-4.74,3.26-8.61,4.53c-4.85,1.67-10.24,2.5-16.19,2.5 C101.41,93.17,94.12,90.45,88.13,85.01z M91.19,52.94H129c0-4.57-1.53-8.39-4.59-11.45c-3.36-3.34-7.93-5.01-13.71-5.01 c-5.4,0-9.93,1.63-13.58,4.89C93.63,44.47,91.66,48.32,91.19,52.94z"/>
</svg>`.trim();

export function buildWhatsAppOtpEmail(input: {
  code: string;
  ttlMinutes: number;
}): { subject: string; text: string; html: string } {
  const subject = "Ton code de connexion WhatsApp Zélo";
  const text = [
    "Bonjour,",
    "",
    "Tu as demandé à activer ton panier Zélo sur WhatsApp.",
    "",
    `Ton code de connexion : ${input.code}`,
    `Il expire dans ${input.ttlMinutes} minutes.`,
    "",
    "Si tu n'es pas à l'origine de cette demande, tu peux ignorer ce message.",
    "",
    "Contacts Zélo :",
    ...ZELO_CONTACTS.map((contact) => `- ${contact}`),
  ].join("\n");

  const contactItems = ZELO_CONTACTS.map(
    (contact) => `<li style="margin:4px 0;color:#334155;">${contact}</li>`
  ).join("");

  const html = `
  <div style="margin:0;padding:0;background:#f3f7ef;font-family:Arial,Helvetica,sans-serif;color:#1f2a1f;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7ef;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #dfead9;box-shadow:0 16px 40px rgba(31,42,31,0.08);">
            <tr>
              <td style="padding:28px 28px 12px 28px;">
                <div style="min-height:48px;">${ZELO_LOGO_SVG}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 0 28px;">
                <p style="margin:0 0 8px 0;color:#5cb135;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Connexion WhatsApp</p>
                <h1 style="margin:0;color:#1f2a1f;font-size:26px;line-height:1.2;">Ton code de connexion Zélo</h1>
                <p style="margin:14px 0 0 0;color:#475569;font-size:16px;line-height:1.55;">Tu as demandé à activer ton panier Zélo sur WhatsApp. Saisis le code ci-dessous dans la conversation pour confirmer que c’est bien toi.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 28px;">
                <div style="background:#f2f8ef;border:1px solid #cfe7c8;border-radius:20px;padding:24px;text-align:center;">
                  <div style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#1f2a1f;">${input.code}</div>
                  <p style="margin:14px 0 0 0;color:#64748b;font-size:14px;">Ce code expire dans ${input.ttlMinutes} minutes.</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 22px 28px;">
                <div style="border-radius:18px;background:#fff7ed;border:1px solid #fed7aa;padding:16px;color:#7c2d12;font-size:14px;line-height:1.5;">
                  Si tu n'es pas à l'origine de cette demande, ignore simplement ce message.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 30px 28px;">
                <p style="margin:0 0 8px 0;color:#1f2a1f;font-size:15px;font-weight:700;">Besoin d’aide ?</p>
                <ul style="margin:0;padding-left:18px;">${contactItems}</ul>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>`.trim();

  return { subject, text, html };
}

export async function sendWhatsAppOtpEmail(input: {
  to: string;
  code: string;
  ttlMinutes: number;
}) {
  const message = buildWhatsAppOtpEmail({
    code: input.code,
    ttlMinutes: input.ttlMinutes,
  });

  return await sendSafeMail({
    to: input.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}
