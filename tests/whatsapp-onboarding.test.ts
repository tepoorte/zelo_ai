import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { env } from "../src/config/env.js";
import {
  WhatsAppOnboardingError,
  WhatsAppOnboardingService,
  type WhatsAppOnboardingOffer,
  type WhatsAppOnboardingDeps,
} from "../src/integrations/meta/whatsapp-onboarding.service.js";
import {
  InMemoryWhatsAppOnboardingStateStore,
  PersistentWhatsAppOnboardingStateStore,
  generateWhatsAppOnboardingStateKey,
  type WhatsAppOnboardingStateStore,
} from "../src/integrations/meta/store/whatsapp-onboarding.store.js";
import { SwissdataOnboardingGatewayError } from "../src/swissdata/whatsapp-onboarding.js";

env.whatsappOnboardingUrl = "https://assistant.example.test/inscription-whatsapp";
env.whatsappOnboardingTtlMinutes = 30;
env.whatsappOnboardingMaxAttempts = 5;
env.whatsappOnboardingLockMinutes = 15;

const phone = "41000000002";
const userRef = `wa:${phone}`;
const user = {
  id: "user-1",
  email: "client@example.test",
  mobile: `+${phone}`,
};
const address = { street: "Rue de Zélo 1", zip: "1000", city: "Lausanne", country: "Suisse" };
const customer = {
  id: "customer-1",
  userId: user.id,
  firstname: "",
  lastname: "",
  email: "",
  mobile: "",
  addresses: [],
  metadata: [],
};

function digits(value: string): string {
  const normalized = value.replace(/\D/g, "");
  return normalized.startsWith("00") ? normalized.slice(2) : normalized;
}

function consentMetadata(input: {
  consentId: string;
  acceptedAt: string;
  termsVersion: string;
  termsUrl: string;
}) {
  return [
    {
      key: "zeloAiWhatsAppOnboardingConsents",
      value: [
        {
          id: input.consentId,
          source: "whatsapp",
          acceptedAt: input.acceptedAt,
          termsVersion: input.termsVersion,
          termsUrl: input.termsUrl,
        },
      ],
    },
  ];
}

function tokenFrom(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("token") ?? "";
}

function tokenFromOffer(offer: WhatsAppOnboardingOffer): string {
  assert.equal(offer.kind, "issued");
  return tokenFrom((offer as Extract<WhatsAppOnboardingOffer, { kind: "issued" }>).url);
}

function completeCustomerLookup() {
  return {
    ok: true as const,
    identity: {
      customerId: customer.id,
      userId: user.id,
      email: user.email,
      mobile: `+${phone}`,
    },
  };
}

function makeDeps(
  overrides: Partial<WhatsAppOnboardingDeps> = {}
): WhatsAppOnboardingDeps {
  let tokenNumber = 0;
  let bound = false;
  const stateStore = new InMemoryWhatsAppOnboardingStateStore({
    encryptionKey: generateWhatsAppOnboardingStateKey(),
  });
  const deps: WhatsAppOnboardingDeps = {
    now: () => Date.parse("2026-09-21T12:00:00.000Z"),
    randomToken: () => String.fromCharCode(65 + tokenNumber++).repeat(43),
    resolveAccountForEmail: async (email) =>
      email.trim().toLowerCase() === user.email
        ? { kind: "unique", userId: user.id }
        : { kind: "none" },
    resolveAccountForPhone: async () => ({ kind: "none" }),
    lookupCustomer: async () =>
      bound
        ? {
            ok: true,
            identity: {
              customerId: customer.id,
              userId: user.id,
              email: user.email,
              mobile: `+${phone}`,
            },
          }
        : { ok: false, reason: "not_found" },
    accountExists: async () => false,
    createAccount: async () => ({
      token: "swissdata-validation-token",
      validation: "emailOrMobile",
    }),
    resendEmailCode: async () => undefined,
    validateAccount: async () => user,
    authenticateAccount: async () => "access-token",
    authenticatePhoneAccount: async () => "access-token",
    currentUser: async () => user,
    ensureCustomer: async () => customer,
    bindCustomerPhone: async () => ({ ...customer, mobile: `+${phone}` }),
    listRegions: async () => [{ id: "region-1", name: "Lausanne" }],
    recordOnboarding: async (input) => {
      bound = true;
      return {
        ...customer,
        firstname: input.firstname,
        lastname: input.lastname,
        email: input.email,
        mobile: `+${phone}`,
        region: input.regionId,
        addresses: [input.address],
        metadata: consentMetadata(input),
      };
    },
    phonesMatch: (left, right) => digits(left) === digits(right),
    stateStore,
    setCustomerSession: (input) => ({
      ...input,
      phoneHash: "phone-hash",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    sendText: async () => ({}),
    sendNewCustomerDiscoveryWelcome: async () => ({
      sent: true,
      offered: false,
      message: "",
    }),
    ...overrides,
  };
  return deps;
}

async function expectError(
  promise: Promise<unknown>,
  code: string,
  status?: number
): Promise<WhatsAppOnboardingError> {
  try {
    await promise;
    assert.fail(`Expected WhatsAppOnboardingError ${code}`);
  } catch (error) {
    assert(error instanceof WhatsAppOnboardingError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    return error;
  }
}

// Meta-verified E.164 numbers are not restricted to the Swiss +41 prefix.
{
  const internationalPhone = "33612345678";
  const service = new WhatsAppOnboardingService(makeDeps());
  assert.equal(
    service.issueOffer({
      userRef: `wa:${internationalPhone}`,
      phone: internationalPhone,
    }).kind,
    "issued"
  );
  assert.throws(
    () => service.issueOffer({ userRef: userRef, phone: internationalPhone }),
    (error: unknown) =>
      error instanceof WhatsAppOnboardingError && error.code === "invalid_principal"
  );
}

// New passwords use exactly the same trim semantics for creation and later authentication.
{
  let createdPassword = "";
  const service = new WhatsAppOnboardingService(
    makeDeps({
      createAccount: async (input) => {
        createdPassword = input.password;
        return { token: "validation-token", validation: "emailOrMobile" };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal(
    (
      await service.start({
        token,
        firstname: "Alice",
        lastname: "Exemple",
        email: user.email,
        address,
        regionId: "region-1",
        password: "  Pa ssword-42  ",
        termsAccepted: true,
      })
    ).stage,
    "account_pending"
  );
  assert.equal(createdPassword, "Pa ssword-42");

  const shortService = new WhatsAppOnboardingService(makeDeps());
  const shortToken = tokenFromOffer(shortService.issueOffer({ userRef, phone }));
  await expectError(
    shortService.start({
      token: shortToken,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "region-1",
      password: "123456789",
      termsAccepted: true,
    }),
    "invalid_password",
    400
  );
}

// Complete new-account flow: Meta-bound phone -> Swissdata validation -> Customer -> session.
{
  let createInput: any;
  let validationCalls = 0;
  let sessionInput: any;
  let recordInput: any;
  let bound = false;
  const discoveryWelcomes: any[] = [];
  const passwordSentinel = "NeverStore-Me-42";
  const deps = makeDeps({
    createAccount: async (input) => {
      createInput = input;
      return { token: "validation-token", validation: "emailOrMobile" };
    },
    validateAccount: async (input) => {
      validationCalls += 1;
      assert.deepEqual(input, { token: "validation-token", emailCode: "a1b2c3" });
      return user;
    },
    authenticateAccount: async (email, password) => {
      assert.equal(email, user.email);
      assert.equal(password, passwordSentinel);
      return "access-token";
    },
    lookupCustomer: async () =>
      bound
        ? {
            ok: true,
            identity: {
              customerId: customer.id,
              userId: user.id,
              email: user.email,
              mobile: `+${phone}`,
            },
          }
        : { ok: false, reason: "not_found" },
    recordOnboarding: async (input) => {
      recordInput = input;
      bound = true;
      return {
        ...customer,
        firstname: input.firstname,
        lastname: input.lastname,
        email: input.email,
        mobile: `+${phone}`,
        region: input.regionId,
        addresses: [input.address],
        metadata: consentMetadata(input),
      };
    },
    setCustomerSession: (input) => {
      sessionInput = input;
      return {
        ...input,
        phoneHash: "phone-hash",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
    },
    sendNewCustomerDiscoveryWelcome: async (input) => {
      discoveryWelcomes.push(input);
      return { sent: true, offered: true, message: "discovery welcome" };
    },
  });
  const service = new WhatsAppOnboardingService(deps);
  const offer = service.issueOffer({ userRef, phone });
  assert.equal(offer.kind, "issued");
  const token = tokenFromOffer(offer);
  assert.equal(token.length, 43);
  assert.equal(
    (offer as Extract<WhatsAppOnboardingOffer, { kind: "issued" }>).url.startsWith(
      "https://assistant.example.test/inscription-whatsapp#token="
    ),
    true
  );
  assert.deepEqual(await service.status(token), {
    ok: true,
    mode: "new_account",
    stage: "offered",
    expiresAt: "2026-09-21T12:30:00.000Z",
  });

  const pending = await service.start({
    token,
    firstname: " Alice ",
    lastname: " Exemple ",
    email: "CLIENT@example.test",
    address,
    regionId: "region-1",
    password: passwordSentinel,
    termsAccepted: true,
    roles: ["admin"],
    appId: "hostile-app",
    userRef: "victim",
    mobile: "+41999999999",
  } as any);
  assert.equal(pending.stage, "account_pending");
  assert.deepEqual(createInput, {
    firstname: "Alice",
    lastname: "Exemple",
    email: "client@example.test",
    password: passwordSentinel,
    clientUrl: env.whatsappOnboardingUrl,
  });

  const storedState = deps.stateStore.read();
  assert.equal(storedState.tickets.length, 1);
  assert.equal("password" in storedState.tickets[0], false);
  assert.equal("emailCode" in storedState.tickets[0], false);
  assert.equal("token" in storedState.tickets[0], false);
  assert.equal(JSON.stringify(storedState).includes(passwordSentinel), false);
  assert.equal(JSON.stringify(storedState).includes("validation-token"), false);

  const completed = await service.complete({
    token,
    emailCode: "A1B2C3",
    password: passwordSentinel,
  });
  assert.equal(completed.stage, "completed");
  assert.equal(validationCalls, 1);
  assert.deepEqual(sessionInput, {
    userRef,
    phone,
    customerId: customer.id,
    userId: user.id,
    email: user.email,
  });
  assert.equal(recordInput.accessToken, "access-token");
  assert.equal(recordInput.customer.id, customer.id);
  assert.equal(recordInput.phone, phone);
  assert.equal(recordInput.regionId, "region-1");
  assert.deepEqual(recordInput.address, address);
  assert.equal(recordInput.termsVersion, "zelo-conditions-generales-2026-09-21");
  assert.deepEqual(discoveryWelcomes, [{ userRef, phone, regionId: "region-1" }]);
  assert.equal(JSON.stringify(discoveryWelcomes).includes(passwordSentinel), false);

  await expectError(service.status(token), "invalid_or_expired_link", 404);
  await expectError(
    service.complete({ token, emailCode: "a1b2c3", password: passwordSentinel }),
    "invalid_or_expired_link",
    404
  );
}

// A User found only through its phone must not turn a fresh onboarding link
// into a password-login flow. Only a complete Customer identity is trusted.
{
  let phoneResolutionCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      resolveAccountForPhone: async () => {
        phoneResolutionCalls += 1;
        return { kind: "unique", userId: "obsolete-user", login: `+${phone}` };
      },
      lookupCustomer: async () => ({ ok: false, reason: "incomplete" }),
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.deepEqual(await service.status(token), {
    ok: true,
    mode: "new_account",
    stage: "offered",
    expiresAt: "2026-09-21T12:30:00.000Z",
  });
  assert.equal(phoneResolutionCalls, 0);
}

// A complete Customer that appears after the initial check blocks account creation.
{
  let collisionIntroduced = false;
  let createCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () =>
        collisionIntroduced
          ? {
              ok: true,
              identity: {
                customerId: "concurrent-customer",
                userId: "concurrent-user",
                email: "concurrent@example.test",
                mobile: `+${phone}`,
              },
            }
          : { ok: false, reason: "incomplete" },
      createAccount: async () => {
        createCalls += 1;
        throw new Error("must not create after a complete Customer appears");
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal((await service.status(token)).mode, "new_account");
  collisionIntroduced = true;
  await expectError(
    service.start({
      token,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "region-1",
      password: "Password-42",
      termsAccepted: true,
    }),
    "account_already_exists",
    409
  );
  assert.equal(createCalls, 0);
}

// A true ambiguity that appears after issuance also fails closed.
{
  let collisionIntroduced = false;
  let createCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () =>
        collisionIntroduced
          ? { ok: false, reason: "ambiguous" }
          : { ok: false, reason: "not_found" },
      createAccount: async () => {
        createCalls += 1;
        throw new Error("must not create for an ambiguous phone");
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal((await service.status(token)).mode, "new_account");
  collisionIntroduced = true;
  await expectError(
    service.start({
      token,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "region-1",
      password: "Password-42",
      termsAccepted: true,
    }),
    "account_ambiguous",
    409
  );
  assert.equal(createCalls, 0);
}

// An email already owned by another Swissdata account is rejected before any
// account creation request is made.
{
  let createCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () => ({ ok: false, reason: "incomplete" }),
      accountExists: async (field, value) => {
        assert.equal(field, "email");
        assert.equal(value, user.email);
        return true;
      },
      createAccount: async () => {
        createCalls += 1;
        throw new Error("must not create an account for an existing email");
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await expectError(
    service.start({
      token,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "region-1",
      password: "Password-42",
      termsAccepted: true,
    }),
    "email_already_exists",
    409
  );
  assert.equal(createCalls, 0);
}

// The production-like legacy record (Customer + User + phone, but no email)
// remains byte-for-byte untouched while a new complete account is created.
{
  const legacyRecord = {
    id: "legacy-customer-2022",
    userId: "legacy-user-2022",
    mobile: `+${phone}`,
    email: "",
    addresses: [{ street: "Ancienne rue 1", zip: "1000", city: "Lausanne", country: "Suisse" }],
  };
  const legacySnapshot = structuredClone(legacyRecord);
  let newCustomerBound = false;
  let sessionInput: any;
  const deps = makeDeps({
      resolveAccountForPhone: async () => ({
        kind: "unique",
        userId: legacyRecord.userId,
        login: "+ 41 76 334 83 51",
      }),
      lookupCustomer: async () =>
        newCustomerBound
          ? {
              ok: true,
              identity: {
                customerId: customer.id,
                userId: user.id,
                email: user.email,
                mobile: `+${phone}`,
              },
            }
          : { ok: false, reason: "incomplete" },
      recordOnboarding: async (input) => {
        newCustomerBound = true;
        return {
          ...customer,
          firstname: input.firstname,
          lastname: input.lastname,
          email: input.email,
          mobile: `+${phone}`,
          region: input.regionId,
          addresses: [input.address],
          metadata: consentMetadata(input),
        };
      },
      setCustomerSession: (input) => {
        sessionInput = input;
        return {
          ...input,
          phoneHash: "hash",
          createdAt: 0,
          expiresAt: 1,
        };
      },
    });
  const service = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal((await service.status(token)).mode, "new_account");
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  assert.equal(
    (
      await service.complete({
        token,
        emailCode: "a1b2c3",
        password: "Password-42",
      })
    ).stage,
    "completed"
  );
  assert.equal(sessionInput.customerId, customer.id);
  assert.deepEqual(legacyRecord, legacySnapshot);
  await expectError(service.status(token), "invalid_or_expired_link");
}

// A valid competing Customer that appears after account creation has started
// is detected before the phone or onboarding metadata can be written.
{
  let competitorAppeared = false;
  let recordCalls = 0;
  let sessionCreated = false;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () =>
        competitorAppeared
          ? {
              ok: true,
              identity: {
                customerId: "competing-customer",
                userId: "competing-user",
                email: "competing@example.test",
                mobile: `+${phone}`,
              },
            }
          : { ok: false, reason: "incomplete" },
      recordOnboarding: async () => {
        recordCalls += 1;
        throw new Error("must not mutate when a competing Customer appears");
      },
      setCustomerSession: (input) => {
        sessionCreated = true;
        return { ...input, phoneHash: "hash", createdAt: 0, expiresAt: 1 };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  competitorAppeared = true;
  await expectError(
    service.complete({ token, emailCode: "a1b2c3", password: "Password-42" }),
    "identity_mismatch",
    409
  );
  assert.equal(recordCalls, 0);
  assert.equal(sessionCreated, false);
  await expectError(service.status(token), "invalid_or_expired_link", 404);
}

// An existing Customer is reconciled with its User and authenticates through
// the Customer email even when User.mobile is empty.
{
  let bindCalled = false;
  let sessionCreated = false;
  const existingIdentity = {
    ok: true as const,
    identity: {
      customerId: customer.id,
      userId: user.id,
      email: user.email,
      mobile: `+${phone}`,
    },
  };
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () => existingIdentity,
      resolveAccountForPhone: async () => ({
        kind: "unique",
        userId: user.id,
        login: "+41 00 000 00 02",
      }),
      authenticateAccount: async (login, password) => {
        assert.equal(login, user.email);
        assert.equal(password, "existing-password");
        return "customer-access-token";
      },
      currentUser: async () => ({ ...user, mobile: "" }),
      ensureCustomer: async () => ({ ...customer, mobile: `+${phone}` }),
      bindCustomerPhone: async () => {
        bindCalled = true;
        throw new Error("an already-bound Customer must not be modified");
      },
      setCustomerSession: (input) => {
        sessionCreated = true;
        return { ...input, phoneHash: "hash", createdAt: 0, expiresAt: 1 };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal((await service.status(token)).mode, "existing_account");
  assert.equal(
    (await service.connect({ token, password: "existing-password" })).stage,
    "completed"
  );
  assert.equal(bindCalled, false);
  assert.equal(sessionCreated, true);
}

// A complete Customer remains authoritative even when a stale standalone User
// happens to expose the same phone number.
{
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () => ({
        ok: true,
        identity: {
          customerId: customer.id,
          userId: user.id,
          email: user.email,
          mobile: `+${phone}`,
        },
      }),
      resolveAccountForPhone: async () => ({
        kind: "unique",
        userId: "different-user",
        login: `+${phone}`,
      }),
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal((await service.status(token)).mode, "existing_account");
}

// An already-issued legacy ticket selected only from a User phone match is
// converted to account creation when no complete Customer identity exists.
{
  let phoneResolutionCalls = 0;
  const deps = makeDeps({
    resolveAccountForPhone: async () => {
      phoneResolutionCalls += 1;
      return { kind: "unique", userId: "obsolete-user", login: user.email };
    },
    lookupCustomer: async () => ({ ok: false, reason: "incomplete" }),
  });
  const service = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  const legacyState = deps.stateStore.read();
  legacyState.tickets[0].mode = "existing_account";
  legacyState.tickets[0].expectedUserId = "obsolete-user";
  legacyState.tickets[0].expectedLogin = user.email;
  deps.stateStore.write(legacyState);

  const status = await service.status(token);
  assert.equal(status.mode, "new_account");
  assert.equal(status.requiresEmail, undefined);
  assert.equal(phoneResolutionCalls, 0);
  const migratedState = deps.stateStore.read();
  assert.equal(migratedState.tickets[0].expectedUserId, undefined);
  assert.equal(migratedState.tickets[0].expectedLogin, undefined);
}

// A transient Customer failure resumes after validation and never validates/creates twice.
{
  let validationCalls = 0;
  let customerCalls = 0;
  const deps = makeDeps({
      validateAccount: async () => {
        validationCalls += 1;
        return user;
      },
      ensureCustomer: async () => {
        customerCalls += 1;
        if (customerCalls === 1) throw new Error("temporary outage");
        return customer;
      },
    });
  const service = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  await expectError(
    service.complete({ token, emailCode: "a1b2c3", password: "Password-42" }),
    "temporarily_unavailable",
    503
  );
  assert.equal(validationCalls, 1);
  assert.equal((await service.status(token)).stage, "account_validated");
  await expectError(service.resend(token), "invalid_stage", 409);
  const replacement = tokenFromOffer(service.issueOffer({ userRef, phone, rotate: true }));
  await expectError(service.status(token), "invalid_or_expired_link", 404);
  assert.equal((await service.status(replacement)).stage, "account_validated");
  const restartedService = new WhatsAppOnboardingService(deps);
  assert.equal(
    (
      await restartedService.complete({
        token: replacement,
        emailCode: "",
        password: "Password-42",
      })
    ).stage,
    "completed"
  );
  assert.equal(validationCalls, 1);
  assert.equal(customerCalls, 2);
}

// A real encrypted state file lets the complete flow resume after a process restart.
{
  const encryptionKey = generateWhatsAppOnboardingStateKey();
  const statePath = path.join(
    mkdtempSync(path.join(os.tmpdir(), "zelo-onboarding-service-restart-")),
    "state.json"
  );
  const firstStore = new PersistentWhatsAppOnboardingStateStore({ statePath, encryptionKey });
  const deps = makeDeps({ stateStore: firstStore });
  const firstService = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(firstService.issueOffer({ userRef, phone }));
  await firstService.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });

  const restartedStore = new PersistentWhatsAppOnboardingStateStore({
    statePath,
    encryptionKey,
  });
  const restartedService = new WhatsAppOnboardingService({
    ...deps,
    stateStore: restartedStore,
  });
  assert.equal((await restartedService.status(token)).stage, "account_pending");
  assert.equal(
    (
      await restartedService.complete({
        token,
        emailCode: "a1b2c3",
        password: "Password-42",
      })
    ).stage,
    "completed"
  );
}

// In-flight locking prevents duplicate create-account mutations.
{
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let createCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      createAccount: async () => {
        createCalls += 1;
        await createGate;
        return { token: "validation-token", validation: "emailOrMobile" };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.status(token);
  const first = service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  await Promise.resolve();
  await expectError(
    service.start({
      token,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "region-1",
      password: "Password-42",
      termsAccepted: true,
    }),
    "request_in_progress",
    409
  );
  assert.equal(service.issueOffer({ userRef, phone, rotate: true }).kind, "active");
  releaseCreate();
  await first;
  assert.equal(createCalls, 1);
  assert.equal((await service.status(token)).stage, "account_pending");
}

// Repeated messages reuse the active offer; only an explicit rotation replaces it.
{
  let now = Date.parse("2026-09-21T12:00:00.000Z");
  const service = new WhatsAppOnboardingService(makeDeps({ now: () => now }));
  const first = tokenFromOffer(service.issueOffer({ userRef, phone }));
  const repeated = service.issueOffer({ userRef, phone });
  assert.equal(repeated.kind, "active");
  assert.equal((await service.status(first)).stage, "offered");

  const second = tokenFromOffer(service.issueOffer({ userRef, phone, rotate: true }));
  assert.notEqual(first, second);
  await expectError(service.status(first), "invalid_or_expired_link", 404);
  assert.equal((await service.status(second)).stage, "offered");
  await expectError(
    Promise.resolve().then(() => service.issueOffer({ userRef, phone, rotate: true })),
    "rotation_cooldown",
    429
  );
  now += 91_000;
  assert.equal(service.issueOffer({ userRef, phone, rotate: true }).kind, "issued");
}

// Rotating a link preserves an already-created account-validation flow.
{
  let createCalls = 0;
  let tokenNumber = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      randomToken: () => String.fromCharCode(75 + tokenNumber++).repeat(43),
      createAccount: async () => {
        createCalls += 1;
        return { token: "validation-token", validation: "emailOrMobile" };
      },
    })
  );
  const first = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token: first,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  const replacement = tokenFromOffer(service.issueOffer({ userRef, phone, rotate: true }));
  await expectError(service.status(first), "invalid_or_expired_link", 404);
  assert.equal((await service.status(replacement)).stage, "account_pending");
  assert.equal(
    (
      await service.complete({
        token: replacement,
        emailCode: "a1b2c3",
        password: "Password-42",
      })
    ).stage,
    "completed"
  );
  assert.equal(createCalls, 1);
}

// A lock after email validation pauses, rather than destroys, the recoverable flow.
{
  let now = Date.parse("2026-09-21T12:00:00.000Z");
  let acceptedPassword = "Password-42";
  let validationCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      now: () => now,
      validateAccount: async () => {
        validationCalls += 1;
        return user;
      },
      authenticateAccount: async (_email, password) => {
        if (password !== acceptedPassword) {
          throw new SwissdataOnboardingGatewayError("credentials");
        }
        return "access-token";
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: acceptedPassword,
    termsAccepted: true,
  });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await expectError(
      service.complete({ token, emailCode: "a1b2c3", password: "Wrong-Password-42" }),
      "completion_failed",
      400
    );
  }
  await expectError(
    service.complete({ token, emailCode: "", password: "Wrong-Password-42" }),
    "too_many_attempts",
    429
  );
  await expectError(service.status(token), "too_many_attempts", 429);
  now += 16 * 60_000;
  assert.equal((await service.status(token)).stage, "account_validated");
  assert.equal(
    (await service.complete({ token, emailCode: "", password: acceptedPassword })).stage,
    "completed"
  );
  assert.equal(validationCalls, 1);
}

// Credential failures lock the principal across newly requested tickets, then expire.
{
  let now = Date.parse("2026-09-21T12:00:00.000Z");
  let sequence = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      now: () => now,
      randomToken: () => String.fromCharCode(65 + sequence++).repeat(43),
      lookupCustomer: async () => completeCustomerLookup(),
      resolveAccountForPhone: async () => ({ kind: "unique", userId: user.id }),
      authenticateAccount: async () => {
        throw new SwissdataOnboardingGatewayError("credentials");
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.status(token);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await expectError(
      service.connect({ token, email: user.email, password: "Wrong-Password-42" }),
      "login_failed",
      400
    );
  }
  await expectError(
    service.connect({ token, email: user.email, password: "Wrong-Password-42" }),
    "too_many_attempts",
    429
  );
  assert.throws(
    () => service.issueOffer({ userRef, phone }),
    (error: any) => error instanceof WhatsAppOnboardingError && error.code === "too_many_attempts"
  );

  now += 16 * 60_000;
  const recoveredToken = tokenFromOffer(service.issueOffer({ userRef, phone }));
  assert.equal(recoveredToken.length, 43);
  await service.status(recoveredToken);
  await expectError(
    service.connect({
      token: recoveredToken,
      email: user.email,
      password: "Wrong-Password-42",
    }),
    "login_failed",
    400
  );
}

// An upstream outage is not counted as a bad password and does not lock the principal.
{
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () => completeCustomerLookup(),
      resolveAccountForPhone: async () => ({ kind: "unique", userId: user.id }),
      authenticateAccount: async () => {
        throw new SwissdataOnboardingGatewayError("upstream");
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.status(token);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await expectError(
      service.connect({ token, email: user.email, password: "Correct-Password-42" }),
      "temporarily_unavailable",
      503
    );
  }
  assert.equal((await service.status(token)).stage, "offered");
}

// Identity mismatches fail closed and invalidate the capability.
{
  let sessionCreated = false;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      lookupCustomer: async () => completeCustomerLookup(),
      resolveAccountForPhone: async () => ({ kind: "unique", userId: user.id }),
      currentUser: async () => ({ ...user, id: "different-user" }),
      setCustomerSession: (input) => {
        sessionCreated = true;
        return {
          ...input,
          phoneHash: "hash",
          createdAt: 0,
          expiresAt: 1,
        };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.status(token);
  await expectError(
    service.connect({ token, email: user.email, password: "Correct-Password-42" }),
    "identity_mismatch",
    409
  );
  assert.equal(sessionCreated, false);
  await expectError(service.status(token), "invalid_or_expired_link", 404);
}

// A logout/revocation that races with completion is re-read before any Customer mutation/session.
{
  let releaseCurrentUser!: () => void;
  let markCurrentUserEntered!: () => void;
  const currentUserGate = new Promise<void>((resolve) => {
    releaseCurrentUser = resolve;
  });
  const currentUserEntered = new Promise<void>((resolve) => {
    markCurrentUserEntered = resolve;
  });
  let recordCalled = false;
  let sessionCreated = false;
  const deps = makeDeps({
    currentUser: async () => {
      markCurrentUserEntered();
      await currentUserGate;
      return user;
    },
    recordOnboarding: async () => {
      recordCalled = true;
      throw new Error("must not mutate after revocation");
    },
    setCustomerSession: (input) => {
      sessionCreated = true;
      return { ...input, phoneHash: "hash", createdAt: 0, expiresAt: 1 };
    },
  });
  const service = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  const completion = service.complete({
    token,
    emailCode: "a1b2c3",
    password: "Password-42",
  });
  await currentUserEntered;
  service.revokeForUserRef(userRef);
  releaseCurrentUser();
  await expectError(completion, "invalid_or_expired_link", 404);
  assert.equal(recordCalled, false);
  assert.equal(sessionCreated, false);
}

// Revocation is also re-read after the owner-scoped Customer lookup itself.
{
  let releaseCustomer!: () => void;
  let markCustomerEntered!: () => void;
  const customerGate = new Promise<void>((resolve) => {
    releaseCustomer = resolve;
  });
  const customerEntered = new Promise<void>((resolve) => {
    markCustomerEntered = resolve;
  });
  let recordCalled = false;
  let sessionCreated = false;
  const deps = makeDeps({
    ensureCustomer: async () => {
      markCustomerEntered();
      await customerGate;
      return customer;
    },
    recordOnboarding: async () => {
      recordCalled = true;
      throw new Error("must not mutate after revocation");
    },
    setCustomerSession: (input) => {
      sessionCreated = true;
      return { ...input, phoneHash: "hash", createdAt: 0, expiresAt: 1 };
    },
  });
  const service = new WhatsAppOnboardingService(deps);
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  const completion = service.complete({
    token,
    emailCode: "a1b2c3",
    password: "Password-42",
  });
  await customerEntered;
  service.revokeForUserRef(userRef);
  releaseCustomer();
  await expectError(completion, "invalid_or_expired_link", 404);
  assert.equal(recordCalled, false);
  assert.equal(sessionCreated, false);
}

// A durable ticket-consumption failure cannot publish an authenticated session.
{
  const backingStore = new InMemoryWhatsAppOnboardingStateStore({
    encryptionKey: generateWhatsAppOnboardingStateKey(),
  });
  let failTicketConsumption = false;
  const stateStore: WhatsAppOnboardingStateStore = {
    read: () => backingStore.read(),
    write: (next) => {
      if (failTicketConsumption && next.tickets.length === 0) {
        throw new Error("simulated persistence failure");
      }
      backingStore.write(next);
    },
    sealPendingAccount: (input) => backingStore.sealPendingAccount(input),
    openPendingAccount: (input) => backingStore.openPendingAccount(input),
  };
  let sessionCreated = false;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      stateStore,
      setCustomerSession: (input) => {
        sessionCreated = true;
        return { ...input, phoneHash: "hash", createdAt: 0, expiresAt: 1 };
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  failTicketConsumption = true;
  await assert.rejects(
    service.complete({ token, emailCode: "a1b2c3", password: "Password-42" }),
    /simulated persistence failure/
  );
  assert.equal(sessionCreated, false);
  assert.equal((await service.status(token)).stage, "account_validated");
}

// Region IDs are server-allowlisted and code resends have an independent cooldown.
{
  let now = Date.parse("2026-09-21T12:00:00.000Z");
  let resendCalls = 0;
  const service = new WhatsAppOnboardingService(
    makeDeps({
      now: () => now,
      resendEmailCode: async () => {
        resendCalls += 1;
      },
    })
  );
  const token = tokenFromOffer(service.issueOffer({ userRef, phone }));
  await expectError(
    service.start({
      token,
      firstname: "Alice",
      lastname: "Exemple",
      email: user.email,
      address,
      regionId: "foreign-region",
      password: "Password-42",
      termsAccepted: true,
    }),
    "invalid_region",
    400
  );
  await service.start({
    token,
    firstname: "Alice",
    lastname: "Exemple",
    email: user.email,
    address,
    regionId: "region-1",
    password: "Password-42",
    termsAccepted: true,
  });
  assert.equal((await service.resend(token)).stage, "account_pending");
  assert.equal(resendCalls, 1);
  await expectError(service.resend(token), "resend_cooldown", 429);
  now += 91_000;
  assert.equal((await service.resend(token)).stage, "account_pending");
  assert.equal(resendCalls, 2);
}

console.log("whatsapp onboarding tests passed");
