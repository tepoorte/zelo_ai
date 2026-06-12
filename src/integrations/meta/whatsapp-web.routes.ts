import { Router } from "express";

import { env } from "../../config/env.js";
import { metaEnv } from "./env.js";
import { isWhatsAppAdminAuthorized } from "./whatsapp-admin.service.js";
import {
  getWhatsAppWebStatus,
  renderWhatsAppWebQrTerminal,
  sendWhatsAppWebTestMessage,
  startWhatsAppWebSession,
} from "./whatsapp-web.service.js";

export function whatsappWebRoutes() {
  const router = Router();

  router.get("/status", async (req, res, next) => {
    try {
      if (!isWhatsAppAdminAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      await startWhatsAppWebSession();
      return res.json({ ok: true, status: getWhatsAppWebStatus() });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/qr", async (req, res, next) => {
    try {
      if (!isWhatsAppAdminAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      await startWhatsAppWebSession();
      const status = getWhatsAppWebStatus();

      if (status.qr && req.query?.format !== "json") {
        const terminalQr = renderWhatsAppWebQrTerminal(status.qr);
        if (req.query?.format === "terminal") {
          return res.type("text/plain").send(terminalQr);
        }

        return res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zelo WhatsApp QR</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#f7faf4; color:#172315; padding:24px; }
    .card { max-width:760px; margin:0 auto; background:white; border:1px solid #d8ead2; border-radius:18px; padding:24px; box-shadow:0 18px 50px rgba(40,80,30,.12); }
    pre { font-size:11px; line-height:1; letter-spacing:0; background:#fff; color:#000; overflow:auto; white-space:pre; }
    p { font-family: system-ui, sans-serif; color:#435240; }
  </style>
</head>
<body>
  <main class="card">
    <h1>QR WhatsApp Zelo</h1>
    <p>Ouvre WhatsApp sur le téléphone du numéro assistant, puis <strong>Appareils connectés</strong> &gt; <strong>Connecter un appareil</strong>.</p>
    <pre>${terminalQr}</pre>
  </main>
</body>
</html>`);
      }

      return res.json({
        ok: true,
        qr: status.qr,
        status,
        instructions:
          "Ouvre WhatsApp sur le téléphone du numéro assistant, puis Appareils connectés > Connecter un appareil.",
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/send-test", async (req, res, next) => {
    try {
      if (!isWhatsAppAdminAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const to = String(req.body?.to ?? metaEnv.whatsappTestPhone ?? "").trim();
      const text = String(req.body?.text ?? "Test Zelo AI WhatsApp").trim();
      if (!to || !text) {
        return res.status(400).json({ ok: false, error: "Missing to or text" });
      }

      await sendWhatsAppWebTestMessage(to, text);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
