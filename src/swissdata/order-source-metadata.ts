export type AssistantOrderChannel = "web" | "whatsapp";

export type SwissdataMetadataEntry = {
  key: string;
  value: unknown;
};

const ASSISTANT_METADATA_KEYS = new Set([
  "Source commande",
  "zeloAiChannel",
]);

function normalizeMetadata(existingMetadata: unknown): SwissdataMetadataEntry[] {
  if (!Array.isArray(existingMetadata)) {
    return [];
  }

  return existingMetadata
    .filter((entry) => {
      return entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string";
    })
    .map((entry) => {
      const metadata = entry as { key: string; value?: unknown };
      return {
        key: metadata.key,
        value: metadata.value,
      };
    });
}

export function withAssistantOrderMetadata(
  existingMetadata: unknown,
  channel: AssistantOrderChannel
): SwissdataMetadataEntry[] {
  const readableChannel = channel === "whatsapp" ? "WhatsApp" : "Web";
  const metadata = normalizeMetadata(existingMetadata);

  return [
    ...metadata.filter((entry) => !ASSISTANT_METADATA_KEYS.has(entry.key)),
    { key: "Source commande", value: `Assistant Zelo ${readableChannel}` },
    { key: "zeloAiChannel", value: channel },
  ];
}
