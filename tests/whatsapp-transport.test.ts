import assert from "node:assert/strict";

import { env } from "../src/config/env.js";
import { metaEnv } from "../src/integrations/meta/env.js";
import {
  sendWhatsAppTypingIndicator,
  splitWhatsAppText,
} from "../src/integrations/meta/whatsapp.send.js";
import { buildWhatsAppOtpEmail } from "../src/integrations/meta/whatsapp-auth-mailer.service.js";
import {
  buildWhatsAppOtpSentMessage,
  ensureWhatsAppPasswordlessSession,
  formatWhatsAppPostLoginMessage,
  type WhatsAppPasswordlessDeps,
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
import {
  clearWhatsAppCustomerSession,
  getWhatsAppCustomerSession,
  setWhatsAppCustomerSession,
} from "../src/swissdata/whatsapp-customer-session.js";

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

function passwordlessDeps(
  lookupCustomer: WhatsAppPasswordlessDeps["lookupCustomer"]
): {
  deps: WhatsAppPasswordlessDeps;
  counters: {
    offerCalls: number;
    issuedOffers: number;
    emails: number;
    rotations: boolean[];
    revocations: string[];
    otpCodes: string[];
  };
} {
  const counters = {
    offerCalls: 0,
    issuedOffers: 0,
    emails: 0,
    rotations: [] as boolean[],
    revocations: [] as string[],
    otpCodes: [] as string[],
  };
  let hasActiveOffer = false;
  return {
    counters,
    deps: {
      lookupCustomer,
      issueOnboardingOffer: (input) => {
        counters.offerCalls += 1;
        counters.rotations.push(input.rotate === true);
        if (hasActiveOffer && !input.rotate) {
          return {
            kind: "active",
            expiresInMinutes: 29,
          };
        }
        hasActiveOffer = true;
        counters.issuedOffers += 1;
        return {
          kind: "issued",
          url: `https://assistant.example.test/inscription-whatsapp#token=TEST-${counters.issuedOffers}`,
          expiresInMinutes: 30,
        };
      },
      sendOtpEmail: async (input) => {
        counters.emails += 1;
        counters.otpCodes.push(input.code);
        return { ok: true } as any;
      },
      revokeOnboarding: (userRef) => {
        counters.revocations.push(userRef);
      },
    },
  };
}

{
  const { deps, counters } = passwordlessDeps(async () => ({ ok: false, reason: "not_found" }));
  const first = await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41700000001", phone: "41700000001", text: "bonjour" },
    deps
  );
  const repeated = await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41700000001", phone: "41700000001", text: "toujours là ?" },
    deps
  );
  assert.equal(first.ok, false);
  assert.equal("message" in first && first.message.includes("Création de ton compte"), true);
  assert.equal("message" in first && first.message.includes("#token=TEST-1"), true);
  assert.equal(repeated.ok, false);
  assert.equal("message" in repeated && repeated.message.includes("déjà actif"), true);
  assert.equal("message" in repeated && repeated.message.includes("#token="), false);
  assert.equal(counters.offerCalls, 2);
  assert.equal(counters.issuedOffers, 1);
  assert.equal(counters.emails, 0);
  assert.deepEqual(counters.rotations, [false, false]);
}

{
  const { deps, counters } = passwordlessDeps(async () => ({ ok: false, reason: "not_found" }));
  await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41700000004", phone: "41700000004", text: "bonjour" },
    deps
  );
  const rotated = await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41700000004", phone: "41700000004", text: "nouveau lien" },
    deps
  );
  assert.equal(rotated.ok, false);
  assert.equal("message" in rotated && rotated.message.includes("#token=TEST-2"), true);
  assert.equal(counters.issuedOffers, 2);
  assert.deepEqual(counters.rotations, [false, true]);
}

for (const reason of ["ambiguous", "missing_user", "missing_email", "config"] as const) {
  const suffix = String(reason.length).padStart(2, "0");
  const { deps, counters } = passwordlessDeps(async () => ({ ok: false, reason }));
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef: `wa:417000001${suffix}`, phone: `417000001${suffix}`, text: "bonjour" },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal("message" in result && result.message.includes("contacte l’équipe Zélo"), true);
  assert.equal(counters.offerCalls, 0);
  assert.equal(counters.emails, 0);
}

{
  const { deps, counters } = passwordlessDeps(async () => {
    throw new Error("upstream unavailable");
  });
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41700000002", phone: "41700000002", text: "bonjour" },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal("message" in result && result.message.includes("temporairement indisponible"), true);
  assert.equal(counters.offerCalls, 0);
  assert.equal(counters.emails, 0);
}

{
  const { deps, counters } = passwordlessDeps(async () => ({
    ok: true,
    identity: {
      customerId: "customer-existing",
      userId: "user-existing",
      email: "existing@example.test",
      mobile: "+41000000003",
    },
  }));
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef: "wa:41000000003", phone: "41000000003", text: "bonjour" },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal("message" in result && result.message.includes("6 chiffres"), true);
  assert.equal(counters.offerCalls, 0);
  assert.equal(counters.emails, 1);
}

{
  const userRef = "wa:41000000004";
  const { deps, counters } = passwordlessDeps(async () => ({
    ok: true,
    identity: {
      customerId: "customer-otp-success",
      userId: "user-otp-success",
      email: "otp-success@example.test",
      mobile: "+41000000004",
    },
  }));
  await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000004", text: "bonjour" },
    deps
  );
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000004", text: counters.otpCodes[0] },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal("message" in result && result.message.includes("Connexion confirmée"), true);
  assert.deepEqual(counters.revocations, [userRef]);
}

// A valid code cannot authenticate a Customer/User mapping that changed after issuance.
{
  const userRef = "wa:41000000005";
  let lookups = 0;
  const { deps, counters } = passwordlessDeps(async () => {
    lookups += 1;
    return {
      ok: true,
      identity: {
        customerId: lookups === 1 ? "customer-original" : "customer-changed",
        userId: "user-otp-mapping",
        email: "mapping@example.test",
        mobile: "+41000000005",
      },
    };
  });
  await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000005", text: "bonjour" },
    deps
  );
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000005", text: counters.otpCodes[0] },
    deps
  );
  assert.equal("message" in result && result.message.includes("contacte l’équipe Zélo"), true);
  assert.equal(getWhatsAppCustomerSession(userRef), null);
}

// Logout always clears an established session even if onboarding-state revocation fails.
{
  const userRef = "wa:41700000008";
  setWhatsAppCustomerSession({
    userRef,
    phone: "41700000008",
    customerId: "customer-logout",
    userId: "user-logout",
    email: "logout@example.test",
  });
  const { deps } = passwordlessDeps(async () => ({ ok: false, reason: "not_found" }));
  deps.revokeOnboarding = () => {
    throw new Error("simulated onboarding-store failure");
  };
  const result = await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41700000008", text: "déconnexion" },
    deps
  );
  assert.equal("message" in result && result.message.includes("Session WhatsApp fermée"), true);
  assert.equal(getWhatsAppCustomerSession(userRef), null);
}

// A logout racing the final OTP ownership check cannot recreate the session afterwards.
{
  const userRef = "wa:41000000006";
  let lookups = 0;
  let releaseLookup!: () => void;
  let markLookupEntered!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const lookupEntered = new Promise<void>((resolve) => {
    markLookupEntered = resolve;
  });
  const { deps, counters } = passwordlessDeps(async () => {
    lookups += 1;
    if (lookups === 2) {
      markLookupEntered();
      await lookupGate;
    }
    return {
      ok: true,
      identity: {
        customerId: "customer-race",
        userId: "user-race",
        email: "race@example.test",
        mobile: "+41000000006",
      },
    };
  });
  await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000006", text: "bonjour" },
    deps
  );
  const validation = ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000006", text: counters.otpCodes[0] },
    deps
  );
  await lookupEntered;
  await ensureWhatsAppPasswordlessSession(
    { userRef, phone: "41000000006", text: "déconnexion" },
    deps
  );
  releaseLookup();
  const result = await validation;
  assert.equal("message" in result && result.message.includes("temporairement indisponible"), true);
  assert.equal(getWhatsAppCustomerSession(userRef), null);
  clearWhatsAppCustomerSession(userRef);
}

{
  const userRef = "wa:41000000007";
  const originalMaxAttempts = env.whatsappOtpMaxAttempts;
  let lookups = 0;
  try {
    env.whatsappOtpMaxAttempts = 1;
    const { deps, counters } = passwordlessDeps(async () => {
      lookups += 1;
      return {
        ok: true,
        identity: {
          customerId: "customer-rate-limit",
          userId: "user-rate-limit",
          email: "rate-limit@example.test",
          mobile: "+41000000007",
        },
      };
    });
    await ensureWhatsAppPasswordlessSession(
      { userRef, phone: "41000000007", text: "bonjour" },
      deps
    );
    const wrongCode = counters.otpCodes[0] === "000000" ? "999999" : "000000";
    const locked = await ensureWhatsAppPasswordlessSession(
      { userRef, phone: "41000000007", text: wrongCode },
      deps
    );
    assert.equal("message" in locked && locked.message.includes("temporairement indisponible"), true);

    const logout = await ensureWhatsAppPasswordlessSession(
      { userRef, phone: "41000000007", text: "déconnexion" },
      deps
    );
    assert.equal("message" in logout && logout.message.includes("Session WhatsApp fermée"), true);
    assert.deepEqual(counters.revocations, [userRef]);

    const afterLogout = await ensureWhatsAppPasswordlessSession(
      { userRef, phone: "41000000007", text: "bonjour" },
      deps
    );
    assert.equal(
      "message" in afterLogout && afterLogout.message.includes("temporairement indisponible"),
      true
    );
    assert.equal(lookups, 1);
    assert.equal(counters.emails, 1);
  } finally {
    env.whatsappOtpMaxAttempts = originalMaxAttempts;
  }
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
  const originalFetch = globalThis.fetch;
  const originalMetaEnv = {
    graphToken: metaEnv.graphToken,
    graphBaseUrl: metaEnv.graphBaseUrl,
    graphVersion: metaEnv.graphVersion,
    whatsappPhoneNumberId: metaEnv.whatsappPhoneNumberId,
  };
  let calledUrl = "";
  let calledInit: RequestInit | undefined;

  try {
    metaEnv.graphToken = "TEST_GRAPH_TOKEN";
    metaEnv.graphBaseUrl = "https://graph.facebook.test";
    metaEnv.graphVersion = "v25.0";
    metaEnv.whatsappPhoneNumberId = "PHONE_NUMBER_ID";
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const response = await sendWhatsAppTypingIndicator({ messageId: "wamid.TEST" });

    assert.deepEqual(response, { success: true });
    assert.equal(calledUrl, "https://graph.facebook.test/v25.0/PHONE_NUMBER_ID/messages");
    assert.equal(calledInit?.method, "POST");
    assert.deepEqual(calledInit?.headers, {
      Authorization: "Bearer TEST_GRAPH_TOKEN",
      "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(String(calledInit?.body)), {
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.TEST",
      typing_indicator: {
        type: "text",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    metaEnv.graphToken = originalMetaEnv.graphToken;
    metaEnv.graphBaseUrl = originalMetaEnv.graphBaseUrl;
    metaEnv.graphVersion = originalMetaEnv.graphVersion;
    metaEnv.whatsappPhoneNumberId = originalMetaEnv.whatsappPhoneNumberId;
  }
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
