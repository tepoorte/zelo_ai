import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import express from "express";

import { whatsappOnboardingRoutes } from "../src/integrations/meta/whatsapp-onboarding.routes.js";
import { WhatsAppOnboardingError } from "../src/integrations/meta/whatsapp-onboarding.service.js";

let capturedStart: any;
let capturedConnect: any;
let capturedRegionToken: string | undefined;
let capturedResendToken: string | undefined;
const service = {
  async status(token: string) {
    if (token === "expired") {
      throw new WhatsAppOnboardingError(
        "invalid_or_expired_link",
        404,
        "Ce lien est invalide ou a expiré."
      );
    }
    if (token === "rate-limited") {
      throw new WhatsAppOnboardingError(
        "too_many_requests",
        429,
        "Trop de demandes.",
        23
      );
    }
    if (token === "email-required") {
      return {
        ok: true as const,
        mode: "existing_account" as const,
        stage: "offered" as const,
        expiresAt: "2026-09-21T12:30:00.000Z",
        requiresEmail: true as const,
      };
    }
    return {
      ok: true as const,
      mode: "new_account" as const,
      stage: "offered" as const,
      expiresAt: "2026-09-21T12:30:00.000Z",
    };
  },
  async regions(token: string) {
    capturedRegionToken = token;
    return {
      ok: true as const,
      regions: [
        { id: "region-lausanne", name: "Lausanne" },
        { id: "region-vevey", name: "Vevey" },
      ],
    };
  },
  async start(input: any) {
    capturedStart = input;
    return {
      ok: true as const,
      mode: "new_account" as const,
      stage: "account_pending" as const,
      expiresAt: "2026-09-21T12:30:00.000Z",
    };
  },
  async complete() {
    return {
      ok: true as const,
      mode: "new_account" as const,
      stage: "completed" as const,
      expiresAt: "2026-09-21T12:30:00.000Z",
    };
  },
  async resend(token: string) {
    capturedResendToken = token;
    return {
      ok: true as const,
      mode: "new_account" as const,
      stage: "account_pending" as const,
      expiresAt: "2026-09-21T12:30:00.000Z",
    };
  },
  async connect(input: any) {
    capturedConnect = input;
    return {
      ok: true as const,
      mode: "existing_account" as const,
      stage: "completed" as const,
      expiresAt: "2026-09-21T12:30:00.000Z",
    };
  },
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.get(["/inscription-whatsapp", "/inscription-whatsapp.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.sendFile(path.join(process.cwd(), "public", "inscription-whatsapp.html"));
});
app.use("/integrations/meta/whatsapp/onboarding", whatsappOnboardingRoutes(service));

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function post(pathname: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

try {
  const page = await fetch(`${baseUrl}/inscription-whatsapp`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control") ?? "", /no-store/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(await page.text(), /Bienvenue chez Zélo/);

  const directPage = await fetch(`${baseUrl}/inscription-whatsapp.html`);
  assert.equal(directPage.status, 200);
  assert.match(directPage.headers.get("cache-control") ?? "", /no-store/);
  assert.match(directPage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(directPage.headers.get("x-frame-options"), "DENY");

  const status = await post("/integrations/meta/whatsapp/onboarding/status", {
    token: "valid-token",
  });
  assert.equal(status.status, 200);
  assert.match(status.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await status.json()).stage, "offered");

  const emailRequiredStatus = await post("/integrations/meta/whatsapp/onboarding/status", {
    token: "email-required",
  });
  assert.equal(emailRequiredStatus.status, 200);
  assert.deepEqual(await emailRequiredStatus.json(), {
    ok: true,
    mode: "existing_account",
    stage: "offered",
    expiresAt: "2026-09-21T12:30:00.000Z",
    requiresEmail: true,
  });

  const regions = await post("/integrations/meta/whatsapp/onboarding/regions", {
    token: "valid-token",
  });
  assert.equal(regions.status, 200);
  assert.deepEqual(await regions.json(), {
    ok: true,
    regions: [
      { id: "region-lausanne", name: "Lausanne" },
      { id: "region-vevey", name: "Vevey" },
    ],
  });
  assert.equal(capturedRegionToken, "valid-token");

  const start = await post("/integrations/meta/whatsapp/onboarding/start", {
    token: "valid-token",
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    address: {
      street: "Rue de Zélo 1",
      zip: "1000",
      city: "Lausanne",
      country: "Suisse",
    },
    regionId: "region-lausanne",
    password: "Password-42",
    termsAccepted: true,
    userRef: "wa:victim",
    mobile: "+41999999999",
    roles: ["admin"],
    appId: "hostile-app",
    customerId: "victim-customer",
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).stage, "account_pending");
  assert.deepEqual(capturedStart, {
    token: "valid-token",
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    address: {
      street: "Rue de Zélo 1",
      zip: "1000",
      city: "Lausanne",
      country: "Suisse",
    },
    regionId: "region-lausanne",
    password: "Password-42",
    termsAccepted: true,
  });

  const complete = await post("/integrations/meta/whatsapp/onboarding/complete", {
    token: "valid-token",
    emailCode: "a1b2c3",
    password: "Password-42",
    userId: "victim-user",
  });
  assert.equal((await complete.json()).stage, "completed");

  const resend = await post("/integrations/meta/whatsapp/onboarding/resend", {
    token: "valid-token",
  });
  assert.equal(resend.status, 200);
  assert.equal((await resend.json()).stage, "account_pending");
  assert.equal(capturedResendToken, "valid-token");

  const connect = await post("/integrations/meta/whatsapp/onboarding/connect", {
    token: "valid-token",
    email: "legacy@example.test",
    password: "Password-42",
    customerId: "victim-customer",
    userId: "victim-user",
  });
  assert.equal((await connect.json()).mode, "existing_account");
  assert.deepEqual(capturedConnect, {
    token: "valid-token",
    email: "legacy@example.test",
    password: "Password-42",
  });

  const expired = await post("/integrations/meta/whatsapp/onboarding/status", {
    token: "expired",
  });
  assert.equal(expired.status, 404);
  assert.deepEqual(await expired.json(), {
    ok: false,
    code: "invalid_or_expired_link",
    message: "Ce lien est invalide ou a expiré.",
  });

  const limited = await post("/integrations/meta/whatsapp/onboarding/status", {
    token: "rate-limited",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "23");
  assert.deepEqual(await limited.json(), {
    ok: false,
    code: "too_many_requests",
    message: "Trop de demandes.",
  });

  const html = await fs.readFile(
    path.join(process.cwd(), "public", "inscription-whatsapp.html"),
    "utf8"
  );
  const js = await fs.readFile(
    path.join(process.cwd(), "public", "inscription-whatsapp.js"),
    "utf8"
  );
  const serverSource = await fs.readFile(path.join(process.cwd(), "src", "server.ts"), "utf8");
  assert.match(html, /pattern="\[0-9a-fA-F\]\{6\}"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /Adresse de livraison/);
  assert.match(html, /name="regionId"/);
  assert.match(html, /id="email-code-field"/);
  assert.match(html, /id="existing-email-field"/);
  assert.match(html, /id="existing-email"[\s\S]*name="email"/);
  assert.match(js, /window\.location\.hash/);
  assert.match(js, /account_validated/);
  assert.match(js, /configureVerification\(false\)/);
  assert.match(js, /\/regions/);
  assert.match(js, /\/resend/);
  assert.match(js, /configureConnection\(status\.requiresEmail === true\)/);
  const verificationHandlerIndex = js.indexOf(
    'document.getElementById("verification-form").addEventListener'
  );
  const connectionHandlerIndex = js.indexOf(
    'document.getElementById("connection-form").addEventListener'
  );
  const emailRequiredDeclaration = "const emailRequired = form.elements.email.required;";
  const emailRequiredIndex = js.indexOf(emailRequiredDeclaration);
  assert(verificationHandlerIndex >= 0);
  assert(connectionHandlerIndex > verificationHandlerIndex);
  assert(emailRequiredIndex > connectionHandlerIndex);
  assert.equal(js.indexOf(emailRequiredDeclaration, emailRequiredIndex + 1), -1);
  assert.equal(
    js.slice(verificationHandlerIndex, connectionHandlerIndex).includes(emailRequiredDeclaration),
    false
  );
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/);
  assert.match(serverSource, /"\/inscription-whatsapp\.html"/);
  assert.match(serverSource, /whatsappOnboardingRoutes\(\)/);
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

console.log("whatsapp onboarding route and UI tests passed");
