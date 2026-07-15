import assert from "node:assert/strict";
import crypto from "node:crypto";

import { env, type AppEnv, validateProductionEnv } from "../src/config/env.js";
import { metaEnv } from "../src/integrations/meta/env.js";
import { verifyMetaSignature } from "../src/integrations/meta/verify.js";
import { isOrderOwnedByCustomerForHistory } from "../src/swissdata/history.js";
import { isAdminTokenAuthorized } from "../src/utils/admin-auth.js";
import { redactSensitive, safeError } from "../src/utils/redaction.js";

function productionEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    nodeEnv: "production",
    aiProvider: "ollama",
    whatsappProvider: "meta_cloud",
    metaVerifyToken: "verify-token",
    metaAppSecret: "meta-app-secret",
    metaGraphToken: "EAATESTTOKEN123456789012345678901234567890",
    metaWhatsappPhoneNumberId: "1274254025760821",
    whatsappAdminToken: "admin-token",
    swissdataBaseUrl: "https://swissdata.example.test",
    swissdataShopId: "shop-id",
    swissdataApiKey: "swissdata-api-key",
    swissdataAdminToken: "swissdata-admin-token",
    swissdataAdminUsername: "",
    swissdataAdminPassword: "",
    smtpHost: "mail.infomaniak.example",
    smtpFrom: "Zelo <public-contact-002@example.invalid>",
    smtpUser: "smtp-user",
    smtpPass: "smtp-pass",
    ...overrides,
  };
}

function fakeReq(headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    query,
    header(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as any;
}

{
  assert.deepEqual(validateProductionEnv(productionEnv()), []);

  const findings = validateProductionEnv(
    productionEnv({
      whatsappProvider: "twilio",
      metaGraphToken: "",
      whatsappAdminToken: "",
      swissdataAdminToken: "",
      swissdataAdminUsername: "",
      swissdataAdminPassword: "",
    })
  );

  assert(findings.includes("WHATSAPP_PROVIDER must be meta_cloud in production"));
  assert(findings.includes("Missing production env: metaGraphToken"));
  assert(findings.includes("Missing production env: whatsappAdminToken"));
  assert(findings.includes("Missing Swissdata admin auth: provide token or username/password"));
}

{
  const openAiFindings = validateProductionEnv(
    productionEnv({
      aiProvider: "openai",
      openaiApiKey: "",
    })
  );
  assert(openAiFindings.includes("Missing production env: openaiApiKey"));
}

{
  assert.equal(
    isAdminTokenAuthorized(fakeReq({ authorization: "Bearer admin-token" }), "admin-token"),
    true
  );
  assert.equal(
    isAdminTokenAuthorized(fakeReq({ "x-zelo-admin-token": "admin-token" }), "admin-token"),
    true
  );
  assert.equal(
    isAdminTokenAuthorized(fakeReq({}, { token: "admin-token" }), "admin-token"),
    true
  );
  assert.equal(isAdminTokenAuthorized(fakeReq({ authorization: "Bearer wrong" }), "admin-token"), false);
}

{
  const sensitive = {
    email: "public-contact-003@example.invalid",
    phone: "+41 00 000 00 01",
    customerId: "000000000000000000000001",
    authorization: "Bearer DUMMY_META_GRAPH_TOKEN_NOT_FOR_USE",
    nested: {
      message: "contact public-contact-003@example.invalid at 0041000000001",
    },
  };

  const redacted = JSON.stringify(redactSensitive(sensitive));
  assert(!redacted.includes("samuel.tepoorten"));
  assert(!redacted.includes("0041000000001"));
  assert(!redacted.includes("000000000000000000000001"));
  assert(!redacted.includes("EAATWQAwWXEUBRZBoh"));

  const redactedUrl = redactSensitive(
    "/ai/intent-feedback?token=admin-token&apiKey=swissdata-key&password=smtp-pass"
  );
  assert(!redactedUrl.includes("admin-token"));
  assert(!redactedUrl.includes("swissdata-key"));
  assert(!redactedUrl.includes("smtp-pass"));
  assert(redactedUrl.includes("token=[redacted]"));
  assert(redactedUrl.includes("apiKey=[redacted]"));

  const redactedHeader = redactSensitive(
    "GET /ai/test?token=query-admin-secret HTTP/1.1\nx-whatsapp-admin-token: header-admin-secret"
  );
  assert(!redactedHeader.includes("query-admin-secret"));
  assert(!redactedHeader.includes("header-admin-secret"));
}

{
  const error = safeError({
    isAxiosError: true,
    name: "AxiosError",
    message: "Request failed for public-contact-003@example.invalid",
    code: "ERR_BAD_REQUEST",
    config: {
      method: "post",
      url: "/shop/admin/000000000000000000000001/order",
      headers: { Authorization: "Bearer secret" },
    },
    response: { status: 401, data: { token: "secret" } },
  });
  const serialized = JSON.stringify(error);
  assert(!serialized.includes("samuel.tepoorten"));
  assert(!serialized.includes("Bearer secret"));
}

{
  const customerId = "000000000000000000000001";
  assert.equal(
    isOrderOwnedByCustomerForHistory({ customerId, products: [] } as any, customerId),
    true
  );
  assert.equal(
    isOrderOwnedByCustomerForHistory(
      { customer: { _id: customerId }, products: [] } as any,
      customerId
    ),
    true
  );
  assert.equal(
    isOrderOwnedByCustomerForHistory({ customerId: "000000000000000000000002", products: [] } as any, customerId),
    false
  );
  assert.equal(isOrderOwnedByCustomerForHistory({ products: [] } as any, customerId), false);
}

{
  const originalSecret = metaEnv.appSecret;
  const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));

  try {
    metaEnv.appSecret = "test-meta-secret";
    const digest = crypto.createHmac("sha256", metaEnv.appSecret).update(rawBody).digest("hex");

    assert.equal(verifyMetaSignature(rawBody, `sha256=${digest}`), true);
    assert.equal(verifyMetaSignature(rawBody, `sha256=${digest.slice(0, -1)}0`), false);
    assert.equal(verifyMetaSignature(rawBody, undefined), false);
    assert.equal(verifyMetaSignature(rawBody, `sha1=${digest}`), false);
  } finally {
    metaEnv.appSecret = originalSecret;
  }
}

console.log("security-hardening.test.ts passed");
