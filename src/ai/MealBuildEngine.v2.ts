import { env } from "../config/env.js";
import { addProductToBasket, getCurrentBasket } from "../swissdata/cart.js";
import { getAllProducts } from "../swissdata/products.js";
import { MealBuildHelpersV2 } from "./MealBuildHelpers.v2.js";
import { computeBasketQty } from "./services/cart-helpers.service.js";
export type MealIngredientV2 = {
  label: string;
  canonicalLabel: string;
  qty: number;
  unit?: string;
  role: "base" | "principal" | "garniture" | "condiment" | "sauce" | "side" | "other";
  optional: boolean;
  isCore: boolean;
  mealContext?: string;
  matchingHints?: {
    synonyms?: string[];
    broaderTerms?: string[];
    avoidTerms?: string[];
    preferredCategoryNames?: string[];
    forbiddenCategoryNames?: string[];
    productForm?: "ingredient" | "prepared" | "condiment" | "base" | "unknown";
  };
};

export type MealPlanV2 = {
  meal: string;
  servings: number;
  ingredients: MealIngredientV2[];
};

export type ProductDocV2 = {
  id: string;
  product: any;
  normalizedName: string;
  normalizedCategoryIds: string[];
  normalizedCategoryNames: string[];
  bucket: "food" | "prepared" | "exclude" | "uncategorized";
  vectors?: {
    name?: number[];
  };
};

export type RankedCandidateV2 = {
  product: any;
  doc: ProductDocV2;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  categoryScore: number;
  penaltyScore: number;
  confidence?: "EXACT" | "GOOD" | "WEAK" | "NONE";
};

export type HandleBuildMealResultV2 = {
  ok: boolean;
  meal: string;
  servings: number;
  added: Array<{
    ingredient: string;
    productId: string;
    productName: string;
    qty: number;
    confidence: string;
  }>;
  missing: Array<{
    ingredient: string;
    optional: boolean;
    reason?: string;
  }>;
  resolvedItems: Array<{
    ingredient: string;
    productId: string;
    productName: string;
    qty: number;
  }>;
  message: string;
};

export class MealBuildEngineV2 {
  private static catalogCache = new Map<string, ProductDocV2[]>();

  static async handleBuildMeal(userRef: string, action: { type: "build_meal"; meal: string; servings?: number }) {
    console.log("[MEAL_ENGINE] START", {
  userRef,
  meal: action.meal,
  servings: action.servings
});
    const meal = String(action.meal || "").trim();
    const servings = Number(action.servings || 1);
    if (!meal) throw new Error("Missing meal name");

    const docs = await this.ensureCatalogIndex(userRef);
    const plan = await this.buildMealPlan(meal, servings);
    console.log("[MEAL_ENGINE] PLAN", plan.ingredients.map(i => ({
  label: i.label,
  role: i.role,
  core: i.isCore
})));
    const matches = [];
    for (const ingredient of plan.ingredients) {
      const ranked = await this.matchIngredient(ingredient, docs);
      matches.push({ ingredient, ranked, best: ranked[0] });
    }
    console.log(
  "[MEAL_ENGINE] MATCH RESULT",
  matches.map(m => ({
    ingredient: m.ingredient.label,
    chosen: m.best?.product?.name,
    confidence: m.best?.confidence,
    score: m.best?.score,
    lexical: m.best?.lexicalScore,
    semantic: m.best?.semanticScore,
    category: m.best?.categoryScore,
    penalty: m.best?.penaltyScore,
  }))
);
    const accepted = matches.filter(m => {
      const c = m.best?.confidence;
      return c === "EXACT" || c === "GOOD" || (c === "WEAK" && !m.ingredient.isCore);
    });

    const missing = matches
      .filter(m => !accepted.includes(m))
      .map(m => ({
        ingredient: m.ingredient.label,
        optional: m.ingredient.optional,
        reason: m.ingredient.isCore
          ? `Missing core ingredient: ${m.ingredient.label}`
          : `Missing optional ingredient: ${m.ingredient.label}`,
      }));

    const coverageOk = MealBuildHelpersV2.hasEnoughCoverage(
      plan.ingredients,
      accepted.map(x => x.ingredient)
    );

    const added = coverageOk ? await this.addAcceptedToBasket(userRef, accepted) : [];

    const resolvedItems = added.map(a => ({
      ingredient: a.ingredient,
      productId: a.productId,
      productName: a.productName,
      qty: a.qty,
    }));

    return {
      ok: coverageOk,
      meal: plan.meal,
      servings: plan.servings,
      added,
      missing,
      resolvedItems,
      message: MealBuildHelpersV2.buildUserMessage(plan.meal, added, missing, coverageOk),
    } satisfies HandleBuildMealResultV2;
  }

  private static async buildMealPlan(meal: string, servings: number): Promise<MealPlanV2> {
    const system = MealBuildHelpersV2.buildPlannerSystemPrompt();
    const user = MealBuildHelpersV2.buildPlannerUserPrompt(meal, servings);

    const resp = await fetch(`${env.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: env.ollamaModel,
        stream: false,
        format: "json",
        options: { temperature: 0.15 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Meal planner failed: ${resp.status} ${txt}`);
    }

    const data = await resp.json() as { message?: { content?: string } };
    console.log("[MEAL_ENGINE] RAW LLM", data?.message?.content);
const plan = MealBuildHelpersV2.parseMealPlan(data?.message?.content || "{}", meal, servings);
console.log("[MEAL_ENGINE] PARSED PLAN", plan);
return plan;
  }

  private static async ensureCatalogIndex(userRef: string): Promise<ProductDocV2[]> {
    const cached = this.catalogCache.get(userRef);
    if (cached?.length) return cached;

    const products = await getAllProducts(userRef);
    const docs = products
      .map((p: any) => MealBuildHelpersV2.toProductDoc(p))
      .filter((d: ProductDocV2) => d.bucket !== "exclude");

    for (const doc of docs) {
      doc.vectors = {
        name: await MealBuildHelpersV2.embedText(doc.normalizedName),
      };
    }

    this.catalogCache.set(userRef, docs);
    console.log("✅ Catalog index v2 ready:", docs.length);
    return docs;
  }

  private static async matchIngredient(ingredient: MealIngredientV2, docs: ProductDocV2[]): Promise<RankedCandidateV2[]> {
    const queryVec = await MealBuildHelpersV2.embedText(ingredient.canonicalLabel || ingredient.label);

    const ranked = docs.map((doc) => {
      const lexicalScore = MealBuildHelpersV2.lexicalScore(ingredient, doc);
      const semanticScore = MealBuildHelpersV2.semanticScore(queryVec, doc.vectors?.name || []);
      const categoryScore = MealBuildHelpersV2.categoryScore(ingredient, doc);
      const penaltyScore = MealBuildHelpersV2.penaltyScore(ingredient, doc);

      const score =
        lexicalScore * 0.45 +
        semanticScore * 0.30 +
        categoryScore * 0.25 -
        penaltyScore;

      const candidate: RankedCandidateV2 = {
        product: doc.product,
        doc,
        score,
        lexicalScore,
        semanticScore,
        categoryScore,
        penaltyScore,
      };

      candidate.confidence = MealBuildHelpersV2.decideConfidence(ingredient, candidate);
      return candidate;
    });

    return ranked.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  private static async addAcceptedToBasket(
    userRef: string,
    accepted: Array<{ ingredient: MealIngredientV2; best: RankedCandidateV2 }>
  ) {
    const basket = await getCurrentBasket(userRef);
    const basketId = basket.id;
    console.log("[MEAL_ENGINE] BASKET BEFORE", {
  basketId,
  basket
});

    const added: Array<{
      ingredient: string;
      productId: string;
      productName: string;
      qty: number;
      confidence: string;
    }> = [];

    for (const item of accepted) {
      const product = item.best.product;
      const qty = computeBasketQty(
  product,
  item.ingredient.qty || 1,
  item.ingredient.unit
);

      console.log("[MEAL_ENGINE] ADD TRY", {
  ingredient: item.ingredient.label,
  productId: product.id,
  productName: product.name,
  qty,
  basketId
});
      await addProductToBasket(userRef, basketId, product.id, qty);

      console.log("[MEAL_ENGINE] ADD DONE", {
  ingredient: item.ingredient.label,
  productId: product.id
});
      added.push({
        ingredient: item.ingredient.label,
        productId: product.id,
        productName: product.name,
        qty,
        confidence: item.best.confidence || "NONE",
      });
    }
    const basketAfter = await getCurrentBasket(userRef);
console.log("[MEAL_ENGINE] BASKET AFTER", basketAfter);

    return added;
  }
}