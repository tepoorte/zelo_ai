import { env } from "../config/env.js";
import { addProductToBasket, getCurrentBasket } from "../swissdata/cart.js";
import { getAllProducts } from "../swissdata/products.js";

type BasketLine = {
  productId: string;
  productName: string;
  qty: number;
};

type MealLLMResult = {
  meal: string;
  servings: number;
  lines: BasketLine[];
};

export class MealBuildEngineV3 {

  static async handleBuildMeal(
    userRef: string,
    action: { type: "build_meal"; meal: string; servings?: number }
  ) {

    const meal = String(action.meal || "").trim();
    const servings = Number(action.servings || 1);

    console.log("[MEAL_V3] START", { meal, servings });

    const basket = await getCurrentBasket(userRef);
    const basketId = basket.id;

    const catalog = await this.loadCatalogLight(userRef);

    const llmResult = await this.callPlannerLLM(meal, servings, catalog);

    console.log("[MEAL_V3] LLM RESULT", llmResult);

    const added: BasketLine[] = [];

    for (const line of llmResult.lines || []) {
      try {
        await addProductToBasket(
          userRef,
          basketId,
          line.productId,
          Math.max(1, Math.round(line.qty || 1))
        );

        added.push(line);

        console.log("[MEAL_V3] ADD OK", line);
      } catch (err) {
        console.log("[MEAL_V3] ADD FAIL", {
          productId: line.productId,
          err: (err as Error).message,
        });
      }
    }

    return {
      ok: added.length > 0,
      meal,
      servings,
      added,
      message:
        added.length > 0
          ? `J’ai ajouté les produits pour "${meal}".`
          : `Je n’ai pas trouvé de combinaison fiable pour "${meal}".`,
    };
  }

  // ------------------------------------------------------

  private static async loadCatalogLight(userRef: string) {
    const products = await getAllProducts(userRef);

    return products.map((p: any) => ({
      id: p.id,
      name: p.name,
      categories: p.categories || [],
    }));
  }

  // ------------------------------------------------------

  private static async callPlannerLLM(
    meal: string,
    servings: number,
    catalog: any[]
  ): Promise<MealLLMResult> {

    const system = `
Tu es un assistant qui construit un panier de courses.

Tu dois choisir UNIQUEMENT des produits présents dans le catalogue fourni.

OBJECTIF:
Construire les ingrédients nécessaires pour cuisiner le plat demandé.

RÈGLES:
- Ne jamais inventer de produit
- Utiliser uniquement les productId fournis
- Adapter la quantité
- Préférer ingrédients simples
- Éviter produits préparés
- Si impossible → retourner lines: []

FORMAT JSON STRICT:

{
  "meal": "string",
  "servings": 2,
  "lines": [
    {
      "productId": "string",
      "productName": "string",
      "qty": 1
    }
  ]
}
`.trim();

    const user = JSON.stringify({
      meal,
      servings,
      catalog,
    });

    const resp = await fetch(`${env.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: env.ollamaModel,
        stream: false,
        format: "json",
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Meal V3 LLM failed: ${resp.status} ${txt}`);
    }

    const data = await resp.json() as { message?: { content?: string } };

    try {
      return JSON.parse(data?.message?.content || "{}");
    } catch {
      console.log("[MEAL_V3] JSON FAIL", data?.message?.content);
      return { meal, servings, lines: [] };
    }
  }
}