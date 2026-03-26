import { env } from "../../../config/env.js";
import { getAllProducts, type Product } from "../../../swissdata/products.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";

type MealCatalogPlan = {
  meal: string;
  selectedProducts: string[];
};

export class MealCatalogBuilderService {
  private async ollamaChat(messages: any[], temperature = 0.2): Promise<string> {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        options: { temperature },
      }),
    });

    const data = await resp.json();
    return data?.message?.content ?? "";
  }

  private safeJsonParse<T>(s: string): T | null {
    try {
      return JSON.parse(s) as T;
    } catch {
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(s.slice(start, end + 1)) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private buildNameMap(products: Product[]): Map<string, Product> {
    const map = new Map<string, Product>();

    for (const p of products) {
      const name = String(p?.name || "").trim();
      if (!name) continue;
      if (!map.has(name)) {
        map.set(name, p);
      }
    }

    return map;
  }

  private buildCatalogNamesString(products: Product[]): string {
    return products
      .map((p) => String(p?.name || "").trim())
      .filter((name) => name.length > 0)
      .join(", ");
  }

  async buildFromMeal(userRef: string, meal: string): Promise<{
    meal: string;
    catalogCount: number;
    catalogNamesString: string;
    selectedNames: string[];
    selectedProducts: Product[];
  }> {
    const products = await getAllProducts(userRef);
    const nameMap = this.buildNameMap(products);
    const catalogNames = [...nameMap.keys()];
    const catalogNamesString = catalogNames.join(", ");

    console.log("[MEAL CATALOG COUNT]", catalogNames.length);
    console.log("[MEAL REQUEST]", meal);
    console.log("[MEAL CATALOG STRING LENGTH]", catalogNamesString.length);

    const messages = [
      {
        role: "system",
        content: `
Tu es un assistant courses.

Ta mission:
Composer un repas UNIQUEMENT avec les noms exacts présents dans le catalogue.

RÈGLES OBLIGATOIRES:
- Réponds uniquement avec du JSON valide.
- Tu ne peux utiliser QUE des noms exacts présents dans le catalogue.
- Tu n'as pas le droit de reformuler un nom produit.
- Tu n'as pas le droit d'inventer un produit.
- Choisis entre 2 et 6 produits maximum.
- Si aucun repas cohérent n'est possible, retourne selectedProducts: [].

FORMAT EXACT:
{
  "meal": "...",
  "selectedProducts": [
    "Nom exact 1",
    "Nom exact 2"
  ]
}
        `.trim(),
      },
      {
        role: "user",
        content: `
Repas demandé: ${meal}

Catalogue disponible (noms exacts uniquement):
${catalogNamesString}
        `.trim(),
      },
    ];

    const raw = await this.ollamaChat(messages, 0.2);
    console.log("[MEAL PLAN RAW]", raw);

    const parsed = this.safeJsonParse<MealCatalogPlan>(raw);

    if (!parsed || !Array.isArray(parsed.selectedProducts)) {
      return {
        meal,
        catalogCount: catalogNames.length,
        catalogNamesString,
        selectedNames: [],
        selectedProducts: [],
      };
    }

    const selectedNames = parsed.selectedProducts
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const selectedProducts = selectedNames
      .map((name) => nameMap.get(name))
      .filter((p): p is Product => !!p);

    console.log("[MEAL SELECTED NAMES]", selectedNames);
    console.log(
      "[MEAL SELECTED PRODUCTS]",
      selectedProducts.map((p) => ({ id: p.id, name: p.name }))
    );

    return {
      meal: parsed.meal || meal,
      catalogCount: catalogNames.length,
      catalogNamesString,
      selectedNames,
      selectedProducts,
    };
  }
}