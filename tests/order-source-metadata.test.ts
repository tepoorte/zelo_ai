import assert from "node:assert/strict";
import { withAssistantOrderMetadata } from "../src/swissdata/order-source-metadata.js";

{
  const metadata = withAssistantOrderMetadata(
    [
      { key: "Livraison", value: "15-07-2026" },
      { key: "Source commande", value: "Ancienne source" },
      { key: "zeloAiChannel", value: "old" },
    ],
    "web"
  );

  assert.deepEqual(metadata, [
    { key: "Livraison", value: "15-07-2026" },
    { key: "Source commande", value: "Assistant Zelo Web" },
    { key: "zeloAiChannel", value: "web" },
  ]);
}

{
  const metadata = withAssistantOrderMetadata(null, "whatsapp");

  assert.deepEqual(metadata, [
    { key: "Source commande", value: "Assistant Zelo WhatsApp" },
    { key: "zeloAiChannel", value: "whatsapp" },
  ]);
}

{
  const metadata = withAssistantOrderMetadata(
    [
      null,
      "bad",
      { key: 123, value: "bad" },
      { key: "A garder", value: true },
    ],
    "whatsapp"
  );

  assert.deepEqual(metadata, [
    { key: "A garder", value: true },
    { key: "Source commande", value: "Assistant Zelo WhatsApp" },
    { key: "zeloAiChannel", value: "whatsapp" },
  ]);
}

console.log("order-source-metadata tests passed");
