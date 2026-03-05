import { runAgent } from "./agent.js";

// Qui potresti anche rispondere su WhatsApp/Messenger con Graph API (send message),
// ma intanto facciamo la logica + log.
export async function handleInboundText(channel: "whatsapp" | "messenger", userId: string, text: string) {
  const userRef = mapChannelUserToSwissdataUserRef(channel, userId);

  const { message } = await runAgent(userRef, text);

  // TODO: send back message via Meta Graph API
  console.log(`[${channel}] user=${userId} => ${text}`);
  console.log(`[AI reply] ${message}`);
}

/**
 * IMPORTANTISSIMO:
 * - Se vuoi che il carrello sul sito si popoli “per lo stesso utente”,
 *   devi avere una regola di mapping: phone/PSID => customerId / userRef Swissdata.
 * - In MVP puoi usare direttamente il phone (WhatsApp) come userRef.
 * - In produzione: una tabella mapping + login/link magic.
 */
function mapChannelUserToSwissdataUserRef(channel: string, userId: string): string {
  // MVP: WhatsApp phone number as userRef, Messenger PSID as userRef prefissato.
  if (channel === "whatsapp") return `wa:${userId}`;
  return `ms:${userId}`;
}