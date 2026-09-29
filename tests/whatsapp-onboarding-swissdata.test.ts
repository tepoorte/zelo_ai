import assert from "node:assert/strict";
import http from "node:http";

import { env } from "../src/config/env.js";
import { lookupWhatsAppCustomerByPhone } from "../src/integrations/meta/whatsapp-auth-swissdata.service.js";
import {
  authenticateSwissdataAccount,
  bindSwissdataCurrentCustomerPhone,
  createSwissdataWhatsAppAccount,
  ensureSwissdataCurrentCustomer,
  getSwissdataCurrentUser,
  listSwissdataOnboardingRegions,
  recordSwissdataWhatsAppOnboarding,
  resendSwissdataWhatsAppEmailCode,
  resolveSwissdataAccountForEmail,
  resolveSwissdataAccountForPhone,
  swissdataAccountExists,
  validateSwissdataWhatsAppAccount,
  type SwissdataOnboardingAddress,
} from "../src/swissdata/whatsapp-onboarding.js";

type CapturedRequest = {
  method: string;
  pathname: string;
  query: Record<string, string>;
  authorization: string;
  body: any;
};

type PhoneLookupResult = { exists: boolean; id?: string };

const phoneLookupResults = new Map<string, PhoneLookupResult>([
  ["+41 00 000 00 02", { exists: true, id: "user-phone-1" }],
  ["+41000001002", { exists: true, id: "user-phone-a" }],
  ["41000001002", { exists: true, id: "user-phone-b" }],
  ["+41000001003", { exists: true }],
  ["+41000001004", { exists: true, id: "user-merge-exact" }],
]);

const emailLookupResults = new Map<string, PhoneLookupResult>([
  ["regex-only@example.test", { exists: true, id: "user-regex-only" }],
  ["idless@example.test", { exists: true }],
]);

const existingAddress: SwissdataOnboardingAddress = {
  street: "Chemin existant 2",
  zip: "1001",
  city: "Lausanne",
  country: "Suisse",
};
const newAddress: SwissdataOnboardingAddress = {
  street: "Rue de Zelo 1",
  zip: "1000",
  city: "Lausanne",
  country: "Suisse",
  description: "Entrée côté cour",
  accessInformation: "Sonner à gauche",
};
const previousConsent = {
  id: "consent-previous",
  source: "whatsapp",
  acceptedAt: "2026-08-20T10:00:00.000Z",
  termsVersion: "zelo-terms-conditions-previous",
  termsUrl: "https://zelo-epicerie.ch/terms-conditions.html?v=previous",
};
const newConsent = {
  id: "consent-current",
  source: "whatsapp",
  acceptedAt: "2026-09-21T12:00:00.000Z",
  termsVersion: "zelo-terms-conditions-current",
  termsUrl: "https://zelo-epicerie.ch/terms-conditions.html",
};
const initialMetadata = [
  { key: "existing", value: { keep: true }, type: "json" },
  { key: "zeloAiWhatsAppOnboardingConsents", value: [previousConsent] },
];

const captured: CapturedRequest[] = [];

async function bodyFrom(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = await bodyFrom(req);
  const request: CapturedRequest = {
    method: req.method ?? "",
    pathname: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries()),
    authorization: String(req.headers.authorization ?? ""),
    body,
  };
  captured.push(request);

  if (request.pathname.startsWith("/user/exists/email/")) {
    const value = request.pathname.slice("/user/exists/email/".length);
    sendJson(res, emailLookupResults.get(value) ?? { exists: false });
    return;
  }

  if (request.pathname.startsWith("/user/exists/mobile/")) {
    const value = request.pathname.slice("/user/exists/mobile/".length);
    sendJson(res, phoneLookupResults.get(value) ?? { exists: false });
    return;
  }

  if (request.method === "GET" && request.pathname === "/search-user") {
    const rawPattern = request.query.q || "";
    const pattern = rawPattern.startsWith("$") ? rawPattern.slice(1) : "(?!)";
    const regex = new RegExp(pattern);
    const users = [
      { id: "user-phone-1", mobile: "+41 00 000 00 02" },
      { id: "user-phone-a", mobile: "+41000001002" },
      { id: "user-phone-b", mobile: "000 000 10 02" },
      { id: "user-regex-only", mobile: "+ 41 00 000 10 05" },
      { id: "user-regex-a", mobile: "00 41 00 000 10 06" },
      { id: "user-regex-b", mobile: "000 000-10-06" },
      { id: "user-merge-exact", mobile: "+41000001004" },
      { id: "user-merge-regex", mobile: "+ 41 00 000 10 04" },
    ];
    const limit = Math.max(0, Number(request.query.limit || 0));
    sendJson(
      res,
      users
        .filter((entry) => regex.test(entry.mobile))
        .slice(0, limit || users.length)
        .map((entry) => ({ id: entry.id }))
    );
    return;
  }

  if (
    request.method === "GET" &&
    request.pathname === "/shop/admin/shop-1/customer"
  ) {
    const rawPattern = request.query.q || "";
    const pattern = rawPattern.startsWith("$") ? rawPattern.slice(1) : "(?!)";
    const regex = new RegExp(pattern);
    const customers = [
      {
        id: "customer-legacy-phone",
        userId: "user-phone-1",
        email: "legacy@example.test",
        mobile: "  + 41 00 000 10 07  ",
        user: {
          id: "user-phone-1",
          email: "legacy@example.test",
          mobile: "00 41 00 000 10 07",
        },
      },
      {
        id: "customer-near-collision",
        userId: "user-other",
        email: "other@example.test",
        mobile: "000 000 10 02",
      },
      {
        id: "customer-incomplete-email",
        userId: "user-incomplete-email",
        mobile: "+41 00 000 10 08",
        addresses: [existingAddress],
        user: {
          id: "user-incomplete-email",
          mobile: "0041000001008",
        },
      },
      {
        id: "customer-stale-alongside-valid",
        userId: "user-stale-alongside-valid",
        mobile: "+41000001009",
        user: {
          id: "user-stale-alongside-valid",
          mobile: "+41000001009",
        },
      },
      {
        id: "customer-valid-alongside-stale",
        userId: "user-valid-alongside-stale",
        email: "valid-alongside-stale@example.test",
        mobile: "000 000 10 09",
        user: {
          id: "user-valid-alongside-stale",
          email: "valid-alongside-stale@example.test",
          mobile: "+41 00 000 10 09",
        },
      },
      {
        id: "customer-valid-ambiguous-a",
        userId: "user-valid-ambiguous-a",
        email: "valid-a@example.test",
        mobile: "+41000001010",
      },
      {
        id: "customer-valid-ambiguous-b",
        userId: "user-valid-ambiguous-b",
        email: "valid-b@example.test",
        mobile: "0041000001010",
      },
      {
        id: "customer-incomplete-user",
        email: "orphan-customer@example.test",
        mobile: "+41000001011",
        addresses: [existingAddress],
      },
      {
        id: "customer-conflicting-user-link",
        userId: "user-direct-conflict",
        email: "conflict@example.test",
        mobile: "+41000001012",
        user: {
          id: "user-populated-conflict",
          email: "conflict@example.test",
          mobile: "+41000001012",
        },
      },
      {
        id: "customer-valid-beside-conflict",
        userId: "user-valid-beside-conflict",
        email: "valid-beside-conflict@example.test",
        mobile: "0041000001012",
      },
      {
        id: "customer-invalid-email-format",
        userId: "user-invalid-email-format",
        email: "not-an-email@localhost",
        mobile: "+41000001013",
      },
    ];
    sendJson(
      res,
      customers.filter((entry) => regex.test(entry.mobile) || regex.test(entry.user?.mobile ?? ""))
    );
    return;
  }

  if (request.method === "POST" && request.pathname === "/user/create-account") {
    sendJson(res, {
      token: "validation-token",
      createAccountValidation: "emailOrMobile",
      expires: "2026-09-23T12:00:00.000Z",
      data: { hash: "must-not-be-retained", roles: ["must-not-be-retained"] },
    });
    return;
  }

  if (request.method === "PUT" && request.pathname === "/user/resend-code") {
    sendJson(res, { ok: true });
    return;
  }

  if (request.method === "PUT" && request.pathname === "/user/create-account") {
    sendJson(res, {
      id: "user-1",
      email: "client@example.test",
      mobile: "",
    });
    return;
  }

  if (request.method === "POST" && request.pathname === "/auth/token") {
    sendJson(res, { token: "access-token", expires: "2026-10-05T12:00:00Z" });
    return;
  }

  if (request.method === "GET" && request.pathname === "/user/current") {
    sendJson(res, {
      id: "user-1",
      email: "client@example.test",
      mobile: "",
    });
    return;
  }

  if (
    request.method === "GET" &&
    request.pathname === "/shop/shop-1/customer/current"
  ) {
    sendJson(res, {
      id: "customer-1",
      userId: "user-1",
      firstname: "Existing",
      lastname: "Profile",
      email: "old@example.test",
      mobile: "",
      addresses: [
        existingAddress,
        { street: "Incomplete address is filtered", zip: "", city: "", country: "" },
      ],
      metadata: initialMetadata,
    });
    return;
  }

  if (request.method === "GET" && request.pathname === "/shop/shop-1/region") {
    sendJson(res, [
      { id: "region-1", name: " Lausanne " },
      { _id: "region-2", name: "Morges" },
      { id: {}, name: "Invalid object id" },
      { id: "region-without-name", name: "" },
    ]);
    return;
  }

  if (
    request.method === "PUT" &&
    request.pathname === "/shop/shop-1/customer/current"
  ) {
    sendJson(res, {
      id: "customer-1",
      userId: "user-1",
      ...body,
    });
    return;
  }

  sendJson(res, { error: "not found" }, 404);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") {
  throw new Error("Missing test server address");
}

const oldBaseUrl = env.swissdataBaseUrl;
const oldApiKey = env.swissdataApiKey;
const oldShopId = env.swissdataShopId;
const oldAdminToken = env.swissdataAdminToken;
env.swissdataBaseUrl = `http://127.0.0.1:${serverAddress.port}`;
env.swissdataApiKey = "public-test-key";
env.swissdataShopId = "shop-1";
env.swissdataAdminToken = "admin-test-token";

try {
  assert.equal(await swissdataAccountExists("email", "client@example.test"), false);

  const creation = await createSwissdataWhatsAppAccount({
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    password: "Password-42",
    clientUrl: "https://assistant.example.test/inscription-whatsapp",
  });
  assert.deepEqual(creation, {
    token: "validation-token",
    validation: "emailOrMobile",
    expires: "2026-09-23T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(creation).includes("must-not-be-retained"), false);

  await resendSwissdataWhatsAppEmailCode({ token: creation.token });

  const validatedUser = await validateSwissdataWhatsAppAccount({
    token: creation.token,
    emailCode: "a1b2c3",
  });
  assert.deepEqual(validatedUser, {
    id: "user-1",
    email: "client@example.test",
    mobile: "",
  });

  const accessToken = await authenticateSwissdataAccount(
    "client@example.test",
    "Password-42"
  );
  assert.equal(accessToken, "access-token");

  const currentUser = await getSwissdataCurrentUser(accessToken);
  assert.deepEqual(currentUser, validatedUser);

  const customer = await ensureSwissdataCurrentCustomer(accessToken);
  assert.equal(customer.id, "customer-1");
  assert.equal(customer.userId, currentUser.id);
  assert.deepEqual(
    {
      firstname: customer.firstname,
      lastname: customer.lastname,
      email: customer.email,
      mobile: customer.mobile,
      region: customer.region,
      addresses: customer.addresses,
    },
    {
      firstname: "Existing",
      lastname: "Profile",
      email: "old@example.test",
      mobile: "",
      region: undefined,
      addresses: [existingAddress],
    }
  );

  const phoneBoundCustomer = await bindSwissdataCurrentCustomerPhone({
    accessToken,
    phone: "41000000002",
  });
  assert.equal(phoneBoundCustomer.id, customer.id);
  assert.equal(phoneBoundCustomer.userId, customer.userId);
  assert.equal(phoneBoundCustomer.mobile, "+41000000002");

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000000002"), {
    ok: true,
    identity: {
      customerId: "customer-legacy-phone",
      userId: "user-phone-1",
      email: "legacy@example.test",
      mobile: "00 41 00 000 10 07",
      displayName: undefined,
    },
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001008"), {
    ok: false,
    reason: "incomplete",
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001009"), {
    ok: true,
    identity: {
      customerId: "customer-valid-alongside-stale",
      userId: "user-valid-alongside-stale",
      email: "valid-alongside-stale@example.test",
      mobile: "+41 00 000 10 09",
      displayName: undefined,
    },
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001010"), {
    ok: false,
    reason: "ambiguous",
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001011"), {
    ok: false,
    reason: "incomplete",
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001012"), {
    ok: false,
    reason: "ambiguous",
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001013"), {
    ok: false,
    reason: "incomplete",
  });

  assert.deepEqual(await lookupWhatsAppCustomerByPhone("41000001014"), {
    ok: false,
    reason: "not_found",
  });

  assert.deepEqual(await listSwissdataOnboardingRegions(), [
    { id: "region-1", name: "Lausanne" },
    { id: "region-2", name: "Morges" },
  ]);

  const recordInput = {
    accessToken,
    phone: "41000000002",
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    address: newAddress,
    regionId: "region-1",
    consentId: newConsent.id,
    acceptedAt: newConsent.acceptedAt,
    termsVersion: newConsent.termsVersion,
    termsUrl: newConsent.termsUrl,
  };
  const updatedCustomer = await recordSwissdataWhatsAppOnboarding({
    ...recordInput,
    customer,
  });
  assert.deepEqual(
    {
      id: updatedCustomer.id,
      userId: updatedCustomer.userId,
      firstname: updatedCustomer.firstname,
      lastname: updatedCustomer.lastname,
      email: updatedCustomer.email,
      mobile: updatedCustomer.mobile,
      region: updatedCustomer.region,
      addresses: updatedCustomer.addresses,
      metadata: updatedCustomer.metadata,
    },
    {
      id: "customer-1",
      userId: "user-1",
      firstname: "Alice",
      lastname: "Exemple",
      email: "client@example.test",
      mobile: "+41000000002",
      region: "region-1",
      addresses: [newAddress, existingAddress],
      metadata: [
        initialMetadata[0],
        {
          key: "zeloAiWhatsAppOnboardingConsents",
          value: [previousConsent, newConsent],
        },
      ],
    }
  );

  const retriedCustomer = await recordSwissdataWhatsAppOnboarding({
    ...recordInput,
    customer: updatedCustomer,
  });
  assert.deepEqual(retriedCustomer, updatedCustomer);

  assert.deepEqual(await resolveSwissdataAccountForPhone("41000000002"), {
    kind: "unique",
    userId: "user-phone-1",
    login: "+41 00 000 00 02",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001002"), {
    kind: "ambiguous",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001003"), {
    kind: "ambiguous",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001015"), {
    kind: "none",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001005"), {
    kind: "unique",
    userId: "user-regex-only",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001006"), {
    kind: "ambiguous",
  });
  assert.deepEqual(await resolveSwissdataAccountForPhone("41000001004"), {
    kind: "ambiguous",
  });
  assert.deepEqual(
    await resolveSwissdataAccountForEmail(" REGEX-ONLY@EXAMPLE.TEST "),
    {
      kind: "unique",
      userId: "user-regex-only",
    }
  );
  assert.deepEqual(await resolveSwissdataAccountForEmail("missing@example.test"), {
    kind: "none",
  });
  assert.deepEqual(await resolveSwissdataAccountForEmail("idless@example.test"), {
    kind: "ambiguous",
  });

  const createRequest = captured.find(
    (request) => request.method === "POST" && request.pathname === "/user/create-account"
  );
  assert(createRequest);
  assert.deepEqual(createRequest.body, {
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    password: "Password-42",
    locale: "fr",
    clientUrl: "https://assistant.example.test/inscription-whatsapp",
  });
  for (const forbidden of ["mobile", "appId", "roles", "userId", "customerId"]) {
    assert.equal(forbidden in createRequest.body, false, `create payload leaked ${forbidden}`);
  }

  const resendRequest = captured.find(
    (request) => request.method === "PUT" && request.pathname === "/user/resend-code"
  );
  assert(resendRequest);
  assert.deepEqual(resendRequest.body, {
    token: "validation-token",
    method: "email",
    locale: "fr",
  });

  const validateRequest = captured.find(
    (request) => request.method === "PUT" && request.pathname === "/user/create-account"
  );
  assert(validateRequest);
  assert.deepEqual(validateRequest.body, {
    token: "validation-token",
    emailCode: "a1b2c3",
  });

  const authRequest = captured.find(
    (request) => request.method === "POST" && request.pathname === "/auth/token"
  );
  assert(authRequest);
  assert.deepEqual(authRequest.body, {
    username: "client@example.test",
    password: "Password-42",
  });

  const regionRequest = captured.find(
    (request) => request.method === "GET" && request.pathname === "/shop/shop-1/region"
  );
  assert(regionRequest);
  assert.deepEqual(regionRequest.query, {
    apiKey: "public-test-key",
    sort: "order",
  });
  assert.equal(regionRequest.authorization, "");

  const customerRequests = captured.filter(
    (request) => request.pathname === "/shop/shop-1/customer/current"
  );
  assert.equal(customerRequests.length, 4);
  assert(customerRequests.every((request) => request.authorization === "Bearer access-token"));
  assert.equal(customerRequests[0].method, "GET");
  assert.equal(customerRequests[0].body, undefined);

  const expectedCustomerUpdate = {
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    mobile: "+41000000002",
    addresses: [newAddress, existingAddress],
    region: "region-1",
    metadata: [
      initialMetadata[0],
      {
        key: "zeloAiWhatsAppOnboardingConsents",
        value: [previousConsent, newConsent],
      },
    ],
  };
  assert.deepEqual(customerRequests[1].body, { mobile: "+41000000002" });
  assert.deepEqual(customerRequests[2].body, expectedCustomerUpdate);
  assert.deepEqual(customerRequests[3].body, expectedCustomerUpdate);
  for (const request of customerRequests.slice(1)) {
    for (const forbidden of ["id", "_id", "userId", "customerId", "shopId", "appId", "roles"]) {
      assert.equal(forbidden in request.body, false, `customer payload leaked ${forbidden}`);
    }
  }

  const userCurrentRequest = captured.find(
    (request) => request.method === "GET" && request.pathname === "/user/current"
  );
  assert.equal(userCurrentRequest?.authorization, "Bearer access-token");
  const adminLookupRequest = captured.find(
    (request) => request.pathname === "/shop/admin/shop-1/customer"
  );
  assert(adminLookupRequest);
  assert.equal(adminLookupRequest.authorization, "Bearer admin-test-token");
  assert.equal(adminLookupRequest.query.autoFetch, "user");
  assert.equal(adminLookupRequest.query.limit, "100");
  assert.equal(adminLookupRequest.query.skip, "0");
  assert.equal(adminLookupRequest.query.q.startsWith("$^"), true);
  assert.equal(adminLookupRequest.query.q.endsWith("$"), true);
  const userSearchRequests = captured.filter(
    (request) => request.method === "GET" && request.pathname === "/search-user"
  );
  assert.equal(userSearchRequests.length, 6);
  assert(
    userSearchRequests.every(
      (request) =>
        request.authorization === "" &&
        request.query.limit === "2" &&
        request.query.q.startsWith("$^") &&
        request.query.q.endsWith("$")
    )
  );
  const emailLookupRequests = captured.filter((request) =>
    request.pathname.startsWith("/user/exists/email/")
  );
  assert(
    emailLookupRequests.some(
      (request) => request.pathname === "/user/exists/email/regex-only@example.test"
    )
  );
  assert.equal(
    captured.some((request) => request.pathname === "/user" && request.method === "GET"),
    false
  );
  assert(captured.every((request) => request.query.apiKey === "public-test-key"));
} finally {
  env.swissdataBaseUrl = oldBaseUrl;
  env.swissdataApiKey = oldApiKey;
  env.swissdataShopId = oldShopId;
  env.swissdataAdminToken = oldAdminToken;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

console.log("whatsapp onboarding Swissdata contract tests passed");
