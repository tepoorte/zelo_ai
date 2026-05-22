import { Router } from "express";
import { runAgent } from "../ai/agent.js";
import { BuildMealEngine } from "../ai/build-meal/engine.js";
import {
  getBuildMealLearningState,
  rememberBuildMealConfirmedExample,
  rememberBuildMealRejectedExample,
} from "../ai/build-meal/learning.service.js";
import { buildUnknownRecipeContext } from "../ai/build-meal/recipe-knowledge.service.js";
import { getRecipeCandidates } from "../ai/build-meal/recipe-memory.js";
import {
  createBuildMealUserRecipe,
  getBuildMealTrainingRuntime,
  getBuildMealUserRecipes,
  recordBuildMealFeedback,
} from "../ai/build-meal/training.service.js";
import { CATEGORY_NAME_BY_ID } from "../ai/food-taxonomy.js";
import { parseFrontendIntentHint } from "../ai/services/frontend-intent-hint.service.js";
import {
  getIntentTrainingRuntime,
  recordIntentFeedback,
} from "../ai/services/intent-feedback.service.js";
import { normalizeText } from "../domain/normalizer.js";
import { login } from "../swissdata/auth.js";
import { ensureCurrentBasketFutureDelivery } from "../swissdata/cart.js";
import { searchProducts } from "../swissdata/products.js";
import { getSession, setSession } from "../swissdata/session.js";
import { withPerfTrace } from "../utils/perf.js";

function bodyString(req: any, key: string, fallback = ""): string {
  return String(req.body?.[key] ?? fallback);
}

function optionalBodyString(req: any, key: string): string | undefined {
  return req.body?.[key] != null ? String(req.body[key]) : undefined;
}

function queryString(req: any, key: string, fallback = ""): string {
  return String(req.query?.[key] ?? fallback);
}

function optionalQueryString(req: any, key: string): string | undefined {
  return req.query?.[key] != null ? String(req.query[key]) : undefined;
}

function registerAuthRoutes(router: Router): void {
  router.post("/login", async (req, res, next) => {
    try {
      const userRef = bodyString(req, "userRef", "local-dev");
      const username = bodyString(req, "username");
      const password = bodyString(req, "password");
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: "Missing username/password" });
      }

      const token = await login(userRef, username, password);
      setSession(userRef, {
        token: token.token,
        refresh: token.refresh,
        expires: token.expires,
      });

      res.json({ ok: true, token: token.token, expires: token.expires });
    } catch (error) {
      next(error);
    }
  });

  router.get("/whoami", (req, res) => {
    const userRef = queryString(req, "userRef", "local-dev");
    const session = getSession(userRef);
    res.json({
      ok: true,
      userRef,
      hasToken: Boolean(session?.token),
      expires: session?.expires ?? null,
    });
  });
}

function registerIntentTrainingRoutes(router: Router): void {
  router.get("/intent-training", async (_req, res, next) => {
    try {
      const training = await getIntentTrainingRuntime();
      res.json({ ok: true, training });
    } catch (error) {
      next(error);
    }
  });

  router.post("/intent-feedback", async (req, res, next) => {
    try {
      const result = await recordIntentFeedback({
        userRef: bodyString(req, "userRef", "local-dev"),
        text: bodyString(req, "text"),
        predictedAction: bodyString(req, "predictedAction") as any,
        correctAction: optionalBodyString(req, "correctAction") as any,
        kind: optionalBodyString(req, "kind") as any,
      });

      res.json({
        ok: true,
        event: result.event,
        training: result.training,
      });
    } catch (error) {
      next(error);
    }
  });
}

function registerBuildMealTrainingRoutes(router: Router): void {
  router.get("/build-meal-training", async (req, res, next) => {
    try {
      const training = await getBuildMealTrainingRuntime(optionalQueryString(req, "userRef"));
      res.json({ ok: true, training });
    } catch (error) {
      next(error);
    }
  });

  router.get("/build-meal-learning-state", async (_req, res, next) => {
    try {
      const state = await getBuildMealLearningState();
      res.json({ ok: true, ...state });
    } catch (error) {
      next(error);
    }
  });

  router.get("/build-meal-recipes", async (req, res, next) => {
    try {
      const store = await getBuildMealUserRecipes(optionalQueryString(req, "userRef"));
      res.json({ ok: true, ...store });
    } catch (error) {
      next(error);
    }
  });

  router.post("/build-meal-recipes", async (req, res, next) => {
    try {
      const result = await createBuildMealUserRecipe({
        userRef: optionalBodyString(req, "userRef"),
        key: optionalBodyString(req, "key"),
        label: bodyString(req, "label"),
        aliases: Array.isArray(req.body?.aliases) ? req.body.aliases.map(String) : undefined,
        examples: Array.isArray(req.body?.examples) ? req.body.examples.map(String) : undefined,
        sourceText: optionalBodyString(req, "sourceText"),
        defaultServings:
          req.body?.defaultServings != null ? Number(req.body.defaultServings) : undefined,
        family: optionalBodyString(req, "family"),
        baseRecipe: Boolean(req.body?.baseRecipe),
        ingredients: Array.isArray(req.body?.ingredients) ? req.body.ingredients : [],
      });

      res.json({
        ok: true,
        recipe: result.recipe,
        training: result.training,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/build-meal-feedback", async (req, res, next) => {
    try {
      const result = await recordBuildMealFeedback({
        mealKey: bodyString(req, "mealKey"),
        ingredientKey: bodyString(req, "ingredientKey"),
        action: bodyString(req, "action") as any,
        productId: optionalBodyString(req, "productId"),
        productName: optionalBodyString(req, "productName"),
        userRef: optionalBodyString(req, "userRef"),
        note: optionalBodyString(req, "note"),
      });

      res.json({
        ok: true,
        event: result.event,
        training: result.training,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/build-meal-match-feedback", async (req, res, next) => {
    try {
      const mealKey = bodyString(req, "mealKey").trim();
      const text = bodyString(req, "text").trim();
      const action = bodyString(req, "action").trim();
      const userRef = optionalBodyString(req, "userRef");
      const reason = optionalBodyString(req, "reason");

      if (!mealKey || !text) {
        return res.status(400).json({ ok: false, error: "Missing mealKey or text" });
      }

      const normalizedText = normalizeText(text);
      if (action === "confirm") {
        const example = await rememberBuildMealConfirmedExample({
          mealKey,
          text,
          normalizedText,
          userRef,
          source: "explicit",
        });
        return res.json({ ok: true, action, example });
      }

      if (action !== "reject") {
        return res.status(400).json({ ok: false, error: "Invalid match feedback action" });
      }

      const rejection = await rememberBuildMealRejectedExample({
        mealKey,
        text,
        normalizedText,
        userRef,
        reason,
      });

      const training = await getBuildMealTrainingRuntime(userRef);
      const candidates = await getRecipeCandidates(text, training);
      const unknownRecipe = buildUnknownRecipeContext({
        userText: text,
        normalizedText,
        servings:
          req.body?.servings != null && Number.isFinite(Number(req.body.servings))
            ? Math.max(1, Number(req.body.servings))
            : 2,
        training,
        candidates,
      });

      return res.json({
        ok: true,
        action,
        rejection,
        unknownRecipe,
      });
    } catch (error) {
      next(error);
    }
  });
}

function registerBuildMealUtilityRoutes(router: Router): void {
  router.post("/build-meal-search", async (req, res, next) => {
    try {
      const userRef = bodyString(req, "userRef", "local-dev");
      const query = bodyString(req, "query").trim();
      const limit =
        req.body?.limit != null && Number.isFinite(Number(req.body.limit))
          ? Math.max(1, Math.min(20, Number(req.body.limit)))
          : 8;

      if (!query) {
        return res.status(400).json({ ok: false, error: "Missing query" });
      }

      const products = await searchProducts(userRef, query, limit);
      res.json({
        ok: true,
        products: products.map((product) => ({
          id: String(product.id),
          name: product.name,
          categories: product.categories || [],
          categoryNames: (product.categories || [])
            .map((categoryId) => CATEGORY_NAME_BY_ID[String(categoryId)])
            .filter(Boolean),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/test", async (req, res, next) => {
    try {
      const parsed = await BuildMealEngine.preview(
        bodyString(req, "text"),
        optionalBodyString(req, "userRef")
      );
      res.json({ ok: true, input: bodyString(req, "text"), ...parsed });
    } catch (error) {
      next(error);
    }
  });
}

function registerBasketAndChatRoutes(router: Router): void {
  router.get("/basket", async (req, res, next) => {
    try {
      const basket = await ensureCurrentBasketFutureDelivery(queryString(req, "userRef", "local-dev"));
      res.json({ ok: true, basket });
    } catch (error) {
      next(error);
    }
  });

  router.post("/chat", async (req, res, next) => {
    try {
      const userRef = bodyString(req, "userRef", "anonymous");
      const text = bodyString(req, "text");
      const frontendIntentHint = parseFrontendIntentHint(req.body?.frontendIntentHint);
      if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

      const output = await withPerfTrace(
        "ai.chat",
        async () => await runAgent(userRef, text, frontendIntentHint),
        {
          userRef,
          textPreview: text.slice(0, 80),
          frontendIntentHintAction: frontendIntentHint?.actionKey,
          frontendIntentHintConfidence: frontendIntentHint?.confidence,
        }
      );
      res.json({ ok: true, userRef, input: text, ...output });
    } catch (error) {
      next(error);
    }
  });
}

export function aiRoutes() {
  const router = Router();

  registerAuthRoutes(router);
  registerIntentTrainingRoutes(router);
  registerBuildMealTrainingRoutes(router);
  registerBuildMealUtilityRoutes(router);
  registerBasketAndChatRoutes(router);

  return router;
}
