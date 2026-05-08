import { runAgent } from "../../ai/agent.js";
import type { TwilioInboundWhatsAppMessage } from "./types.js";
import { resolveTwilioWhatsAppUserRef } from "./store/identity-map.js";
import { hasSeenTwilioMessage, markTwilioMessageSeen } from "./store/message-dedup.js";
import { getStoredToken, login } from "../../swissdata/auth.js";
import { setSession } from "../../swissdata/session.js";

type ParsedLoginCommand =
  | { kind: "missing" }
  | { kind: "invalid_format" }
  | { kind: "login"; username: string; password: string };

function parseLoginCommand(text: string): ParsedLoginCommand {
  const trimmed = text.trim();
  const match = trimmed.match(/^login\s+(\S+)\s+(.+)$/i);
  if (!match) {
    return /^login\b/i.test(trimmed) ? { kind: "invalid_format" } : { kind: "missing" };
  }

  return {
    kind: "login",
    username: match[1].trim(),
    password: match[2].trim(),
  };
}

async function loginTwilioWhatsAppUser(userRef: string, username: string, password: string) {
  const session = await login(userRef, username, password);
  setSession(userRef, {
    token: session.token,
    refresh: session.refresh,
    expires: session.expires,
  });
}

export async function processIncomingTwilioWhatsAppMessage(
  message: TwilioInboundWhatsAppMessage
) {
  if (hasSeenTwilioMessage(message.messageSid)) {
    return "Message déjà traité.";
  }
  markTwilioMessageSeen(message.messageSid);

  if (message.numMedia && message.numMedia > 0) {
    return "Je peux t’aider avec les messages texte pour le moment.";
  }

  const userRef = resolveTwilioWhatsAppUserRef(message.from);
  const loginCommand = parseLoginCommand(message.body);

  if (loginCommand.kind === "login") {
    await loginTwilioWhatsAppUser(userRef, loginCommand.username, loginCommand.password);
    return "Connexion réussie. Tu peux maintenant gérer ton panier ici sur WhatsApp.";
  }

  if (loginCommand.kind === "invalid_format") {
    return "Format de connexion invalide. Utilise : login login-example-001@example.invalid ton_mot_de_passe";
  }

  if (!getStoredToken(userRef)) {
    return "Avant d’utiliser le panier, connecte-toi ici avec : login login-example-001@example.invalid ton_mot_de_passe";
  }

  const reply = await runAgent(userRef, message.body);
  return reply.message;
}
