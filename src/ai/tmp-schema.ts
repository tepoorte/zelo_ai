// src/ai/schema.ts
export const tools = [
  {
    type: "function" as const,
    name: "search_products",
    description: "Cerca prodotti esistenti nel catalogo Swissdata (per nome, tag, sinonimi).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Testo di ricerca (es. 'parmigiano', 'insalata romana')." },
        limit: { type: "number", description: "Massimo risultati (default 5)." }
      },
      required: ["query"]
    }
  },
  {
    type: "function" as const,
    name: "add_to_cart",
    description: "Aggiunge una lista di prodotti (già risolti) al carrello dell'utente.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        userRef: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              productId: { type: "string" },
              qty: { type: "number" }
            },
            required: ["productId", "qty"]
          }
        }
      },
      required: ["userRef", "items"]
    }
  },
  {
    type: "function" as const,
    name: "get_cart",
    description: "Legge il carrello corrente dell'utente.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        userRef: { type: "string" }
      },
      required: ["userRef"]
    }
  }
];