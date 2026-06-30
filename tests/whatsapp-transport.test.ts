import assert from "node:assert/strict";

import { splitWhatsAppText } from "../src/integrations/meta/whatsapp.send.js";
import { buildWhatsAppOtpEmail } from "../src/integrations/meta/whatsapp-auth-mailer.service.js";
import {
  buildWhatsAppOtpSentMessage,
  formatWhatsAppPostLoginMessage,
} from "../src/integrations/meta/whatsapp-auth.service.js";
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
  const message = buildWhatsAppOtpSentMessage();
  assert.equal(message.includes("*Connexion à ton panier Zélo*"), true);
  assert.equal(message.includes("*6 chiffres*"), true);
  assert.equal(message.includes("courriers indésirables"), true);
}

{
  const message = formatWhatsAppPostLoginMessage([
    { productId: "p1", name: "Beurre frais", source: "history" },
    { productId: "p2", name: "Pain Balance", source: "history" },
    { productId: "p3", name: "Gruyère doux", source: "history" },
  ]);
  assert.equal(message.includes("*Connexion confirmée*"), true);
  assert.equal(message.includes("Salut !"), false);
  assert.equal(message.includes("Que veux-tu commander aujourd’hui ?"), true);
  assert.equal(message.includes("• « montre mon panier »"), true);
  assert.equal(message.includes("• Beurre frais"), true);
  assert.equal(message.includes("Quand tout est bon, écris « ok »"), true);
}

{
  const message = formatWhatsAppPostLoginMessage([]);
  assert.equal(message.includes("Tu prends souvent aussi"), false);
  assert.equal(message.includes("• « passe la commande »"), true);
}

{
  const email = buildWhatsAppOtpEmail({ code: "083857", ttlMinutes: 10 });
  assert.equal(email.subject, "Ton code de connexion WhatsApp Zélo");
  assert.equal(email.text.includes("083857"), true);
  assert.equal(email.html.includes("083857"), true);
  assert.equal(email.html.includes("public-contact-006@example.invalid"), true);
  assert.equal(email.html.includes("public-contact-003@example.invalid"), true);
  assert.equal(email.html.includes("+41 00 000 00 02"), true);
  assert.equal(/password|mot de passe|hash|token/i.test(email.text), false);
  assert.equal(/password|mot de passe|hash|token/i.test(email.html), false);
}

{
  let loginCalled = false;
  let sessionSet = false;
  const deps: WhatsAppSessionDeps = {
    getStoredToken: () => undefined,
    getWhatsAppCustomerSession: () => null,
    ensurePasswordlessSession: async () => ({ ok: false, message: "OTP sent" }),
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
    authMode: "legacy_dev",
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
  const deps: WhatsAppSessionDeps = {
    getStoredToken: () => undefined,
    getWhatsAppCustomerSession: () => null,
    ensurePasswordlessSession: async (input) => ({
      ok: false,
      message: `OTP:${input.userRef}:${input.phone}`,
    }),
    login: async () => {
      throw new Error("password login must not be called in otp mode");
    },
    setSession: () => {
      throw new Error("legacy session must not be set in otp mode");
    },
    nodeEnv: "production",
    testPhone: "41000000002",
    testUsername: "public-contact-003@example.invalid",
    testPassword: "dummy_public_test_password",
    authMode: "otp",
  };

  const result = await ensureWhatsAppSwissdataSession(
    { userRef: "wa:41000000002", phone: "41000000002", text: "ajoute 2 pains" },
    deps
  );

  assert.deepEqual(result, { ok: false, message: "OTP:wa:41000000002:41000000002" });
}

{
  let passwordlessText = "";
  const deps: WhatsAppSessionDeps = {
    getStoredToken: () => undefined,
    getWhatsAppCustomerSession: () => ({
      userRef: "wa:41000000002",
      phone: "41000000002",
      phoneHash: "phone-hash",
      customerId: "customer-1",
      userId: "user-1",
      email: "sa***@example.test",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    ensurePasswordlessSession: async (input) => {
      passwordlessText = input.text;
      return { ok: false, message: "Session WhatsApp fermée." };
    },
    login: async () => {
      throw new Error("password login must not be called in otp mode");
    },
    setSession: () => {
      throw new Error("legacy session must not be set in otp mode");
    },
    nodeEnv: "production",
    testPhone: "41000000002",
    testUsername: "public-contact-003@example.invalid",
    testPassword: "dummy_public_test_password",
    authMode: "otp",
  };

  const result = await ensureWhatsAppSwissdataSession(
    { userRef: "wa:41000000002", phone: "41000000002", text: "déconnexion" },
    deps
  );

  assert.deepEqual(result, { ok: false, message: "Session WhatsApp fermée." });
  assert.equal(passwordlessText, "déconnexion");
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
  let runAgentCalled = false;
  const deps: WhatsAppConversationDeps = {
    runAgent: async () => {
      runAgentCalled = true;
      throw new Error("OTP messages must not be routed to runAgent");
    },
    buildIntentHint: async () => ({
      actionKey: "noop",
      confidence: 99,
      family: "noop",
      planner: "planner/noop",
    }),
    ensureSession: async () => ({ ok: false, message: "*Connexion confirmée*" }),
    isAllowedPhone: () => true,
  };

  const reply = await buildWhatsAppConversationReply(
    {
      channel: "whatsapp",
      userId: "+41000000002",
      text: "083857",
      messageId: "MSG-OTP",
    },
    deps
  );

  assert.equal(reply.message, "*Connexion confirmée*");
  assert.equal(runAgentCalled, false);
}

{
  const parts = splitWhatsAppText(`A\n${"x".repeat(3600)}`, 1000);
  assert.equal(parts.length >= 4, true);
  assert.equal(parts.every((part) => part.length <= 1000), true);
}

console.log("whatsapp-transport tests passed");
