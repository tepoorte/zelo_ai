import { runAgent } from "./agent.js";

export async function handleInboundText(
  channel: "whatsapp" | "messenger",
  userId: string,
  text: string
) {
  const userRef = mapChannelUserToSwissdataUserRef(channel, userId);
  const { message } = await runAgent(userRef, text);

  console.log(`[${channel}] user=${userId} => ${text}`);
  console.log(`[AI reply] ${message}`);
}

function mapChannelUserToSwissdataUserRef(channel: string, userId: string): string {
  if (channel === "whatsapp") return `wa:${userId}`;
  return `ms:${userId}`;
}
