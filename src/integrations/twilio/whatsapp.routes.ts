import express, { Router } from "express";
import { parseTwilioWhatsAppWebhook } from "./whatsapp.parse.js";
import { processIncomingTwilioWhatsAppMessage } from "./whatsapp.service.js";
import { buildTwilioMessagingResponse } from "./twiml.js";
import { verifyTwilioSignature } from "./verify.js";
import {
  getTwilioWhatsAppLink,
  linkTwilioWhatsAppUser,
} from "./store/identity-map.js";

export function twilioWhatsAppRoutes() {
  const router = Router();

  router.use(express.urlencoded({ extended: false }));

  router.post("/webhook", async (req, res) => {
    if (!verifyTwilioSignature(req)) {
      return res.status(401).type("text/plain").send("Invalid Twilio signature");
    }

    const message = parseTwilioWhatsAppWebhook(req.body);
    if (!message) {
      return res
        .status(200)
        .type("text/xml")
        .send(buildTwilioMessagingResponse("Message vide ou non pris en charge."));
    }

    try {
      const reply = await processIncomingTwilioWhatsAppMessage(message);
      return res.status(200).type("text/xml").send(buildTwilioMessagingResponse(reply));
    } catch (error) {
      console.error("[twilio][whatsapp] webhook error", error);
      return res
        .status(200)
        .type("text/xml")
        .send(
          buildTwilioMessagingResponse(
            "Je rencontre un petit souci technique. Réessaie dans un instant."
          )
        );
    }
  });

  router.post("/link", express.json(), (req, res) => {
    const from = String(req.body?.from ?? "").trim();
    const userRef = String(req.body?.userRef ?? "").trim();

    if (!from || !userRef) {
      return res.status(400).json({ ok: false, error: "Missing from or userRef" });
    }

    const record = linkTwilioWhatsAppUser(from, userRef);
    return res.json({ ok: true, record });
  });

  router.get("/link/:from", (req, res) => {
    const from = decodeURIComponent(String(req.params.from ?? "").trim());
    return res.json({ ok: true, from, record: getTwilioWhatsAppLink(from) ?? null });
  });

  return router;
}
