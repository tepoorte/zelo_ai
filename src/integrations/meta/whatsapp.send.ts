import { assertWhatsAppSendConfig, metaEnv } from "./env.js";
import type { WhatsAppOutboundTextMessage } from "./types.js";

type GraphSendResponse = {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string; message_status?: string }>;
};

export async function sendWhatsAppText(input: WhatsAppOutboundTextMessage) {
  assertWhatsAppSendConfig();

  const url =
    `${metaEnv.graphBaseUrl}/${metaEnv.graphVersion}/` +
    `${metaEnv.whatsappPhoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${metaEnv.graphToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      ...(input.replyToMessageId ? { context: { message_id: input.replyToMessageId } } : {}),
      text: {
        preview_url: input.previewUrl ?? false,
        body: input.body,
      },
    }),
  });

  const raw = await response.text();
  let data: GraphSendResponse | { error?: unknown };
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw };
  }

  if (!response.ok) {
    throw new Error(`WhatsApp send failed (${response.status}): ${raw}`);
  }

  return data;
}

export function splitWhatsAppText(text: string, maxChars = 3500): string[] {
  const input = text.trim();
  if (!input) return [];
  if (input.length <= maxChars) return [input];

  const lines = input.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    if (line.length <= maxChars) {
      current = line;
      continue;
    }

    let rest = line;
    while (rest.length > maxChars) {
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return chunks;
}
