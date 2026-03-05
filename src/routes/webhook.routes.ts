import { Router } from "express";
import { env } from "../config/env.js";
import { verifyMetaSignature } from "../channels/verify.js";
import { parseWhatsAppWebhook } from "../channels/whattsapp.cloud.js";
import { parseMessengerWebhook } from "../channels/messenger.js";
import { handleInboundText } from "../ai/planner.js";

export function webhookRoutes() {
  const r = Router();

  // Verification handshake (GET)
  r.get("/:channel", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === env.metaVerifyToken) {
      return res.status(200).send(String(challenge));
    }
    return res.sendStatus(403);
  });

  // Webhook receiver (POST)
  r.post("/:channel", async (req, res) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const sig = req.header("x-hub-signature-256");

    if (!raw || !verifyMetaSignature(raw, sig)) {
      return res.sendStatus(401);
    }

    const channel = req.params.channel;

    let messages: Array<{ channel: string; userId: string; text: string }> = [];
    if (channel === "whatsapp") messages = parseWhatsAppWebhook(req.body);
    else if (channel === "messenger") messages = parseMessengerWebhook(req.body);
    else return res.sendStatus(404);

    // process each inbound message
    for (const m of messages) {
      await handleInboundText(m.channel as any, m.userId, m.text);
    }

    // Meta expects 200 quickly
    res.sendStatus(200);
  });

  return r;
}