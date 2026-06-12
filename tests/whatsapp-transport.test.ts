import assert from "node:assert/strict";

import { splitWhatsAppText } from "../src/integrations/meta/whatsapp.send.js";
import {
  buildWhatsAppConversationReply,
  type WhatsAppConversationDeps,
} from "../src/integrations/meta/whatsapp.service.js";
import {
  ensureWhatsAppSwissdataSession,
  normalizeWhatsAppPhone,
  parseWhatsAppLoginCommand,
  type WhatsAppSessionDeps,
} from "../src/integrations/meta/whatsapp-session.service.js";
import { parseBaileysInboundTextMessage } from "../src/integrations/meta/whatsapp-web.service.js";

{
  assert.equal(normalizeWhatsAppPhone("+41 00 000 00 02"), "41000000002");
  assert.equal(normalizeWhatsAppPhone("public-contact-004@example.invalid"), "41000000002");
  assert.equal(normalizeWhatsAppPhone("0041000000002"), "41000000002");
}

{
  assert.deepEqual(parseWhatsAppLoginCommand("bonjour"), { kind: "missing" });
  assert.deepEqual(parseWhatsAppLoginCommand("login"), { kind: "invalid_format" });
  assert.deepEqual(parseWhatsAppLoginCommand("login public-contact-003@example.invalid dummy_public_test_password"), {
    kind: "login",
    username: "public-contact-003@example.invalid",
    password: "dummy_public_test_password",
  });
}

{
  const inbound = parseBaileysInboundTextMessage({
    key: {
      remoteJid: "public-contact-004@example.invalid",
      fromMe: false,
      id: "MSG-1",
    },
    message: {
      conversation: "ajoute 2 pains",
    },
    pushName: "Samuel",
  } as any);

  assert.deepEqual(inbound, {
    channel: "whatsapp",
    userId: "41000000002",
    text: "ajoute 2 pains",
    messageId: "MSG-1",
    fromName: "Samuel",
  });
}

{
  const inbound = parseBaileysInboundTextMessage({
    key: {
      remoteJid: "public-contact-004@example.invalid",
      fromMe: false,
      id: "MSG-2",
    },
    message: {
      extendedTextMessage: { text: "montre mon panier" },
    },
  } as any);

  assert.equal(inbound?.text, "montre mon panier");
}

{
  const inbound = parseBaileysInboundTextMessage({
    key: {
      remoteJid: "public-contact-005@example.invalid",
      fromMe: false,
      id: "GROUP-1",
    },
    message: {
      conversation: "ajoute 2 pains",
    },
  } as any);

  assert.equal(inbound, null);
}

{
  let loginCalled = false;
  let sessionSet = false;
  const deps: WhatsAppSessionDeps = {
    getStoredToken: () => undefined,
    login: async () => {
      loginCalled = true;
      return { token: "token", refresh: "refresh", expires: "tomorrow" };
    },
    setSession: () => {
      sessionSet = true;
    },
    nodeEnv: "development",
    testPhone: "41000000002",
    testUsername: "public-contact-003@example.invalid",
    testPassword: "dummy_public_test_password",
  };

  const result = await ensureWhatsAppSwissdataSession(
    { userRef: "wa:41000000002", phone: "41000000002", text: "ajoute 2 pains" },
    deps
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(loginCalled, true);
  assert.equal(sessionSet, true);
}

{
  let runAgentText = "";
  let hintAction = "";
  const deps: WhatsAppConversationDeps = {
    runAgent: async (_userRef, text, hint) => {
      runAgentText = text;
      hintAction = String(hint?.actionKey || "");
      return { message: "OK agent" };
    },
    buildIntentHint: async () => ({
      actionKey: "add_items",
      confidence: 99,
      family: "add",
      planner: "planner/add_items",
    }),
    ensureSession: async () => ({ ok: true }),
    isAllowedPhone: () => true,
  };

  const reply = await buildWhatsAppConversationReply(
    {
      channel: "whatsapp",
      userId: "+41000000002",
      text: "ajoute 2 pains",
      messageId: "MSG-3",
    },
    deps
  );

  assert.equal(reply.userRef, "wa:41000000002");
  assert.equal(reply.message, "OK agent");
  assert.equal(runAgentText, "ajoute 2 pains");
  assert.equal(hintAction, "add_items");
}

{
  const parts = splitWhatsAppText(`A\n${"x".repeat(3600)}`, 1000);
  assert.equal(parts.length >= 4, true);
  assert.equal(parts.every((part) => part.length <= 1000), true);
}

console.log("whatsapp-transport tests passed");
