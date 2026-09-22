import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InMemoryWhatsAppOnboardingStateStore,
  PersistentWhatsAppOnboardingStateStore,
  WhatsAppOnboardingStateStoreError,
  generateWhatsAppOnboardingStateKey,
  type WhatsAppOnboardingState,
} from "../src/integrations/meta/store/whatsapp-onboarding.store.js";

const key = generateWhatsAppOnboardingStateKey();
const tempDir = mkdtempSync(path.join(os.tmpdir(), "zelo-onboarding-store-"));
const statePath = path.join(tempDir, "whatsapp-onboarding-state.json");

const baseState: WhatsAppOnboardingState = {
  version: 1,
  tickets: [
    {
      tokenHash: "a".repeat(64),
      userRef: "wa:41770000000",
      canonicalPhone: "41770000000",
      createdAt: 1,
      expiresAt: 2,
      generation: 1,
      stage: "account_pending",
      mode: "new_account",
      consent: {
        id: "consent-1",
        acceptedAt: "2026-09-21T12:00:00.000Z",
        termsVersion: "zelo-terms-v1",
        termsUrl: "https://assistant.example.test/conditions",
      },
    },
  ],
  activeTokenHashByUserRef: { "wa:41770000000": "a".repeat(64) },
  generationsByUserRef: { "wa:41770000000": 1 },
  revokedGenerationByUserRef: {},
  rateBucketsByUserRef: {
    "wa:41770000000": {
      failures: 1,
      lockedUntil: 0,
      lastFailureAt: 1,
      offers: 2,
      offerWindowStartedAt: 1,
      starts: 3,
      startWindowStartedAt: 1,
      lastRotationAt: 1,
      codeResends: 4,
      codeResendWindowStartedAt: 1,
      lastCodeResendAt: 1,
    },
  },
  revocations: [
    {
      tokenHash: "b".repeat(64),
      userRef: "wa:41770000000",
      revokedAt: 1,
      expiresAt: 2,
      reason: "replaced",
    },
  ],
};

{
  const store = new PersistentWhatsAppOnboardingStateStore({ statePath, encryptionKey: key });
  const pending = store.sealPendingAccount({
    email: "client@example.test",
    firstname: "Alice",
    lastname: "Example",
    address: {
      street: "Rue de Zelo 1",
      zip: "1000",
      city: "Lausanne",
      country: "S".repeat(80),
    },
    regionId: "region-1",
    swissdataValidationToken: "swissdata-validation-token",
  });
  baseState.tickets[0].pendingAccount = pending;
  store.write(baseState);

  const serialized = readFileSync(statePath, "utf8");
  assert(!serialized.includes("swissdata-validation-token"));
  assert(!serialized.includes("password"));
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.deepEqual(store.openPendingAccount(pending), {
    email: "client@example.test",
    firstname: "Alice",
    lastname: "Example",
    address: {
      street: "Rue de Zelo 1",
      zip: "1000",
      city: "Lausanne",
      country: "S".repeat(80),
    },
    regionId: "region-1",
    swissdataValidationToken: "swissdata-validation-token",
  });

  const restarted = new PersistentWhatsAppOnboardingStateStore({ statePath, encryptionKey: key });
  assert.deepEqual(restarted.read(), baseState);
  assert.deepEqual(restarted.openPendingAccount(restarted.read().tickets[0].pendingAccount!), {
    email: "client@example.test",
    firstname: "Alice",
    lastname: "Example",
    address: {
      street: "Rue de Zelo 1",
      zip: "1000",
      city: "Lausanne",
      country: "S".repeat(80),
    },
    regionId: "region-1",
    swissdataValidationToken: "swissdata-validation-token",
  });
}

{
  const store = new PersistentWhatsAppOnboardingStateStore({ statePath, encryptionKey: key });
  const pending = store.read().tickets[0].pendingAccount!;
  const wrongKeyStore = new PersistentWhatsAppOnboardingStateStore({
    statePath,
    encryptionKey: generateWhatsAppOnboardingStateKey(),
  });
  assert.throws(
    () => wrongKeyStore.openPendingAccount(pending),
    (error: unknown) =>
      error instanceof WhatsAppOnboardingStateStoreError && error.code === "decryption_failed"
  );

  const tampered = {
    ...pending,
    ciphertext: `${pending.ciphertext[0] === "A" ? "B" : "A"}${pending.ciphertext.slice(1)}`,
  };
  assert.throws(
    () => store.openPendingAccount(tampered),
    (error: unknown) =>
      error instanceof WhatsAppOnboardingStateStoreError && error.code === "decryption_failed"
  );
}

{
  const store = new InMemoryWhatsAppOnboardingStateStore({ encryptionKey: key });
  const first = store.read();
  first.tickets.push({
    tokenHash: "c".repeat(64),
    userRef: "wa:41770000001",
    canonicalPhone: "41770000001",
    createdAt: 1,
    expiresAt: 2,
    generation: 1,
    stage: "offered",
  });
  assert.equal(store.read().tickets.length, 0);
  store.write(first);
  assert.equal(store.read().tickets.length, 1);
}

{
  const corruptPath = path.join(tempDir, "corrupt.json");
  writeFileSync(corruptPath, "{ nope", { mode: 0o600 });
  assert.throws(
    () => new PersistentWhatsAppOnboardingStateStore({ statePath: corruptPath, encryptionKey: key }),
    (error: unknown) => error instanceof WhatsAppOnboardingStateStoreError && error.code === "state_corrupt"
  );
}

{
  const insecurePath = path.join(tempDir, "insecure.json");
  writeFileSync(insecurePath, JSON.stringify({ ...baseState, tickets: [] }), { mode: 0o644 });
  assert.throws(
    () => new PersistentWhatsAppOnboardingStateStore({ statePath: insecurePath, encryptionKey: key }),
    (error: unknown) => error instanceof WhatsAppOnboardingStateStoreError && error.code === "state_insecure"
  );
}

console.log("whatsapp onboarding state store tests passed");
