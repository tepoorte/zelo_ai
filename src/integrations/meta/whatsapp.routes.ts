import { Router } from "express";
import { metaEnv } from "./env.js";
import { parseWhatsAppWebhook } from "./whatsapp.parse.js";
import { verifyMetaSignature } from "./verify.js";
import { processIncomingWhatsAppTexts } from "./whatsapp.service.js";
import { getWhatsAppLink, linkWhatsAppUser } from "./store/identity-map.js";

function readVerificationQuery(req: any) {
  return {
    mode: typeof req.query?.["hub.mode"] === "string" ? req.query["hub.mode"] : undefined,
    verifyToken:
      typeof req.query?.["hub.verify_token"] === "string"
        ? req.query["hub.verify_token"]
        : undefined,
    challenge:
      typeof req.query?.["hub.challenge"] === "string" ? req.query["hub.challenge"] : undefined,
  };
}

export function whatsappMetaRoutes() {
  const router = Router();

  router.get("/webhook", (req, res) => {
    const query = readVerificationQuery(req);
    if (query.mode === "subscribe" && query.verifyToken === metaEnv.verifyToken) {
      return res.status(200).send(String(query.challenge ?? ""));
    }
    return res.sendStatus(403);
  });

  router.post("/webhook", (req, res) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const signature = req.header("x-hub-signature-256");

    if (!raw || !verifyMetaSignature(raw, signature)) {
      return res.sendStatus(401);
    }

    const messages = parseWhatsAppWebhook(req.body);
    res.sendStatus(200);

    if (messages.length === 0) return;

    void processIncomingWhatsAppTexts(messages).catch((error) => {
      console.error("[whatsapp] processing error", error);
    });
  });

  router.post("/link", (req, res) => {
    const waId = String(req.body?.waId ?? "").trim();
    const userRef = String(req.body?.userRef ?? "").trim();

    if (!waId || !userRef) {
      return res.status(400).json({ ok: false, error: "Missing waId or userRef" });
    }

    const record = linkWhatsAppUser(waId, userRef);
    return res.json({ ok: true, record });
  });

  router.get("/link/:waId", (req, res) => {
    const waId = String(req.params.waId ?? "").trim();
    const record = getWhatsAppLink(waId);
    return res.json({ ok: true, waId, record: record ?? null });
  });

  return router;
}
