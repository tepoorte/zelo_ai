import assert from "node:assert/strict";
import {
  clearSession,
  createWebSessionIdentity,
  getSessionById,
  maskPrincipal,
  setSession,
} from "../src/swissdata/session.js";

function fakeToken(label: string) {
  return {
    token: `token-${label}`,
    refresh: `refresh-${label}`,
    expires: "2099-01-01T00:00:00.000Z",
    username: `${label}@example.test`,
  };
}

const alice = createWebSessionIdentity();
const bob = createWebSessionIdentity();

assert.notEqual(alice.sessionId, bob.sessionId, "web session ids must be unique");
assert.notEqual(alice.userRef, bob.userRef, "web principals must be unique");

setSession(alice.userRef, {
  ...fakeToken("alice"),
  sessionId: alice.sessionId,
});
setSession(bob.userRef, {
  ...fakeToken("bob"),
  sessionId: bob.sessionId,
});

assert.equal(getSessionById(alice.sessionId)?.userRef, alice.userRef);
assert.equal(getSessionById(alice.sessionId)?.session.username, "alice@example.test");
assert.equal(getSessionById(bob.sessionId)?.userRef, bob.userRef);
assert.equal(getSessionById(bob.sessionId)?.session.username, "bob@example.test");
assert.notEqual(
  getSessionById(alice.sessionId)?.session.token,
  getSessionById(bob.sessionId)?.session.token,
  "tokens must remain scoped to their own web session"
);

const masked = maskPrincipal(alice.userRef);
assert.equal(masked.length, 12);
assert(!masked.includes(alice.sessionId), "masked principal must not leak the session id");

clearSession(alice.userRef);
assert.equal(getSessionById(alice.sessionId), undefined);
assert.equal(getSessionById(bob.sessionId)?.userRef, bob.userRef);

clearSession(bob.userRef);
console.log("session-isolation.test.ts passed");
