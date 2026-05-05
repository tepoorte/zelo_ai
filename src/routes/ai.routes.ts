/*import { Router } from "express";
import { runAgent } from "../ai/agent.js";

export function aiRoutes() {
  const r = Router();

  r.post("/chat", async (req, res, next) => {
    try {
      const { userRef, text } = req.body;
      if (!userRef || !text) {
        return res.status(400).json({ error: "Missing userRef or text" });
      }

      const result = await runAgent(userRef, text);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
  */
//-----------------------------------------------------------------------------
/*import { Router } from "express";

export function aiRoutes() {
  const r = Router();

  r.post("/test", async (req, res) => {
    const text = String(req.body?.text ?? "");
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    // finto “NLP”
    const intent = /caesar|cesar/i.test(text) ? "ADD_RECIPE" : "UNKNOWN";
    const items =
      intent === "ADD_RECIPE"
        ? ["lattuga", "parmigiano", "croûtons", "pollo", "salsa caesar"]
        : [];

    return res.json({
      ok: true,
      input: text,
      intent,
      proposedCartItems: items,
    });
  });

  return r;
}
*/

//-----------------------------------------------------------------------------
import { Router } from "express";
import { runAgent } from "../ai/agent.js";
import { BuildMealEngine } from "../ai/build-meal/engine.js";
import { login } from "../swissdata/auth.js";
import { setSession, getSession } from "../swissdata/session.js";
import { getCurrentBasket } from "../swissdata/cart.js";
import { searchProducts } from "../swissdata/products.js";
import { withPerfTrace } from "../utils/perf.js";
import {
  createBuildMealUserRecipe,
  getBuildMealUserRecipes,
  getBuildMealTrainingRuntime,
  recordBuildMealFeedback,
} from "../ai/build-meal/training.service.js";
import { getBuildMealLearningState } from "../ai/build-meal/learning.service.js";
import { CATEGORY_NAME_BY_ID } from "../ai/food-taxonomy.js";
import {
  getIntentTrainingRuntime,
  recordIntentFeedback,
} from "../ai/services/intent-feedback.service.js";
import type { FrontendIntentHint } from "../ai/services/planner.service.js";

export function aiRoutes() {
  const r = Router();

  function parseFrontendIntentHint(value: any): FrontendIntentHint | undefined {
    if (!value || typeof value !== "object") return undefined;

    const actionKey = value.actionKey != null ? String(value.actionKey) : "";
    if (!actionKey) return undefined;

    return {
      actionKey: actionKey as FrontendIntentHint["actionKey"],
      confidence:
        value.confidence != null && Number.isFinite(Number(value.confidence))
          ? Number(value.confidence)
          : undefined,
      family: value.family != null ? String(value.family) : undefined,
      planner: value.planner != null ? String(value.planner) : undefined,
    };
  }

  r.post("/login", async (req, res, next) => {
    try {
      const userRef = String(req.body?.userRef ?? "local-dev");
      const username = String(req.body?.username ?? "");
      const password = String(req.body?.password ?? "");
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: "Missing username/password" });
      }

      const t = await login(userRef, username, password);

      // salva sessione in RAM
      setSession(userRef, { token: t.token, refresh: t.refresh, expires: t.expires });

      // ritorna anche il token (per debug)
      res.json({ ok: true, token: t.token, expires: t.expires });
    } catch (e) {
      next(e);
    }
  });

  r.get("/whoami", (req, res) => {
    const userRef = String(req.query.userRef ?? "local-dev");
    const s = getSession(userRef);
    res.json({ ok: true, userRef, hasToken: !!s?.token, expires: s?.expires ?? null });
  });

  r.get("/intent-training", async (_req, res, next) => {
    try {
      const training = await getIntentTrainingRuntime();
      res.json({ ok: true, training });
    } catch (e) {
      next(e);
    }
  });

  r.post("/intent-feedback", async (req, res, next) => {
    try {
      const userRef = String(req.body?.userRef ?? "local-dev");
      const text = String(req.body?.text ?? "");
      const predictedAction = String(req.body?.predictedAction ?? "");
      const correctAction = req.body?.correctAction != null
        ? String(req.body.correctAction)
        : undefined;
      const kind = req.body?.kind != null
        ? String(req.body.kind)
        : undefined;

      const result = await recordIntentFeedback({
        userRef,
        text,
        predictedAction: predictedAction as any,
        correctAction: correctAction as any,
        kind: kind as any,
      });

      res.json({
        ok: true,
        event: result.event,
        training: result.training,
      });
    } catch (e) {
      next(e);
    }
  });

  r.get("/build-meal-training", async (_req, res, next) => {
    try {
      const userRef =
        _req.query?.userRef != null ? String(_req.query.userRef) : undefined;
      const training = await getBuildMealTrainingRuntime(userRef);
      res.json({ ok: true, training });
    } catch (e) {
      next(e);
    }
  });

  r.get("/build-meal-learning-state", async (_req, res, next) => {
    try {
      const state = await getBuildMealLearningState();
      res.json({ ok: true, ...state });
    } catch (e) {
      next(e);
    }
  });

  r.get("/build-meal-recipes", async (req, res, next) => {
    try {
      const userRef =
        req.query?.userRef != null ? String(req.query.userRef) : undefined;
      const store = await getBuildMealUserRecipes(userRef);
      res.json({ ok: true, ...store });
    } catch (e) {
      next(e);
    }
  });

  r.post("/build-meal-recipes", async (req, res, next) => {
    try {
      const result = await createBuildMealUserRecipe({
        userRef: req.body?.userRef != null ? String(req.body.userRef) : undefined,
        key: req.body?.key != null ? String(req.body.key) : undefined,
        label: String(req.body?.label ?? ""),
        aliases: Array.isArray(req.body?.aliases) ? req.body.aliases.map(String) : undefined,
        examples: Array.isArray(req.body?.examples) ? req.body.examples.map(String) : undefined,
        sourceText: req.body?.sourceText != null ? String(req.body.sourceText) : undefined,
        defaultServings:
          req.body?.defaultServings != null ? Number(req.body.defaultServings) : undefined,
        family: req.body?.family != null ? String(req.body.family) : undefined,
        baseRecipe: Boolean(req.body?.baseRecipe),
        ingredients: Array.isArray(req.body?.ingredients) ? req.body.ingredients : [],
      });

      res.json({
        ok: true,
        recipe: result.recipe,
        training: result.training,
      });
    } catch (e) {
      next(e);
    }
  });

  r.post("/build-meal-feedback", async (req, res, next) => {
    try {
      const mealKey = String(req.body?.mealKey ?? "");
      const ingredientKey = String(req.body?.ingredientKey ?? "");
      const action = String(req.body?.action ?? "");
      const productId =
        req.body?.productId != null ? String(req.body.productId) : undefined;
      const productName =
        req.body?.productName != null ? String(req.body.productName) : undefined;
      const userRef =
        req.body?.userRef != null ? String(req.body.userRef) : undefined;
      const note =
        req.body?.note != null ? String(req.body.note) : undefined;

      const result = await recordBuildMealFeedback({
        mealKey,
        ingredientKey,
        action: action as any,
        productId,
        productName,
        userRef,
        note,
      });

      res.json({
        ok: true,
        event: result.event,
        training: result.training,
      });
    } catch (e) {
      next(e);
    }
  });

  r.post("/build-meal-search", async (req, res, next) => {
    try {
      const userRef = String(req.body?.userRef ?? "local-dev");
      const query = String(req.body?.query ?? "").trim();
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
    } catch (e) {
      next(e);
    }
  });

  r.post("/test", async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? "");
      const userRef =
        req.body?.userRef != null ? String(req.body.userRef) : undefined;
      const parsed = await BuildMealEngine.preview(text, userRef);
      res.json({ ok: true, input: text, ...parsed });
    } catch (e) {
      next(e);
    }
  });

    r.get("/basket", async (req, res, next) => {
    try {
      const userRef = String(req.query.userRef ?? "local-dev");
      const basket = await getCurrentBasket(userRef);
      res.json({ ok: true, basket });
    } catch (e) {
      next(e);
    }
  });
  r.post("/chat", async (req, res, next) => {
    try {
      const userRef = String(req.body?.userRef ?? "anonymous");
      const text = String(req.body?.text ?? "");
      const frontendIntentHint = parseFrontendIntentHint(req.body?.frontendIntentHint);
      if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

      const out = await withPerfTrace(
        "ai.chat",
        async () => await runAgent(userRef, text, frontendIntentHint),
        {
          userRef,
          textPreview: text.slice(0, 80),
          frontendIntentHintAction: frontendIntentHint?.actionKey,
          frontendIntentHintConfidence: frontendIntentHint?.confidence,
        }
      );
      res.json({ ok: true, userRef, input: text, ...out });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
