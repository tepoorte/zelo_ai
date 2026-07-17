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
import { rankAssistantEligibleProducts } from "../ai/product-eligibility.js";
import { parseFrontendIntentHint } from "../ai/services/frontend-intent-hint.service.js";
import {
  getIntentTrainingRuntime,
  recordIntentFeedback,
} from "../ai/services/intent-feedback.service.js";
import { getNextHistorySuggestions } from "../ai/services/history-suggestions.service.js";
import { env } from "../config/env.js";
import { normalizeText } from "../domain/normalizer.js";
import { clearStoredToken, login } from "../swissdata/auth.js";
import { ensureCurrentBasketFutureDelivery } from "../swissdata/cart.js";
import { getAllProducts } from "../swissdata/products.js";
import {
  SESSION_COOKIE_NAME,
  clearSession,
  clearSessionById,
  createWebSessionIdentity,
  getSessionById,
  maskPrincipal,
  setSession,
} from "../swissdata/session.js";
import { withPerfTrace } from "../utils/perf.js";
import { isAdminTokenAuthorized } from "../utils/admin-auth.js";
import { redactSensitive } from "../utils/redaction.js";

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

function readCookie(req: any, name: string): string | undefined {
  const header = String(req.headers?.cookie ?? "");
  if (!header) return undefined;

  const prefix = `${name}=`;
  const part = header
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  return part ? decodeURIComponent(part.slice(prefix.length)) : undefined;
}

function requestSessionId(req: any): string | undefined {
  const headerSession = String(req.headers?.["x-zelo-session-id"] ?? "").trim();
  return headerSession || readCookie(req, SESSION_COOKIE_NAME);
}

function authenticatedUser(req: any): { userRef: string; session: any; sessionId: string } | undefined {
  const sessionId = requestSessionId(req);
  const resolved = getSessionById(sessionId);
  if (!sessionId || !resolved) return undefined;
  return { ...resolved, sessionId };
}

function requireAuthenticatedUser(req: any, res: any): { userRef: string; session: any; sessionId: string } | undefined {
  const auth = authenticatedUser(req);
  if (!auth) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return undefined;
  }
  return auth;
}

function isLocalRequest(req: any): boolean {
  const host = String(req.headers?.host ?? "")
    .split(":")[0]
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function shouldUseSecureCookie(req: any): boolean {
  if (isLocalRequest(req)) return false;
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProto === "https" || env.nodeEnv === "production");
}

function sessionCookieOptions(req: any) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: shouldUseSecureCookie(req),
    path: "/",
  };
}

function setSessionCookie(req: any, res: any, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...sessionCookieOptions(req),
  });
}

function clearSessionCookie(req: any, res: any): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    ...sessionCookieOptions(req),
  });
}

function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const [name = "", domain = ""] = email.split("@");
  const maskedName = name.length <= 2 ? `${name.slice(0, 1)}…` : `${name.slice(0, 2)}…${name.slice(-1)}`;
  return domain ? `${maskedName}@${domain}` : maskedName;
}

function logSecurityEvent(event: string, meta: Record<string, unknown>): void {
  console.log(`[SECURITY] ${event}`, JSON.stringify(redactSensitive(meta)));
}

function allowInternalRoute(req: any, res: any): boolean {
  if (env.nodeEnv !== "production") return true;
  if (isAdminTokenAuthorized(req)) return true;

  res.sendStatus(404);
  return false;
}

function upstreamStatus(error: any): number | undefined {
  const status = Number(error?.response?.status ?? error?.status);
  return Number.isFinite(status) ? status : undefined;
}

function registerAuthRoutes(router: Router): void {
  router.post("/login", async (req, res, next) => {
    const username = bodyString(req, "username");
    try {
      const password = bodyString(req, "password");
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: "Missing username/password" });
      }

      const existingSessionId = requestSessionId(req);
      const existingSession = getSessionById(existingSessionId);
      if (existingSession) {
        clearStoredToken(existingSession.userRef);
        clearSession(existingSession.userRef);
      } else {
        clearSessionById(existingSessionId);
      }

      const { sessionId, userRef } = createWebSessionIdentity();
      const token = await login(userRef, username, password);
      setSession(userRef, {
        token: token.token,
        refresh: token.refresh,
        expires: token.expires,
        username,
        sessionId,
      });

      setSessionCookie(req, res, sessionId);
      logSecurityEvent("web_login", {
        principal: maskPrincipal(userRef),
        email: maskEmail(username),
        secureCookie: shouldUseSecureCookie(req),
      });
      res.json({
        ok: true,
        expires: token.expires,
        user: {
          email: username,
        },
      });
    } catch (error) {
      const status = upstreamStatus(error);
      logSecurityEvent("web_login_failed", {
        email: maskEmail(username),
        upstreamStatus: status ?? null,
      });
      if (status === 400 || status === 401 || status === 403) {
        return res.status(401).json({ ok: false, error: "Invalid username/password" });
      }
      if (status && status >= 500) {
        return res.status(502).json({ ok: false, error: "Authentication service unavailable" });
      }
      next(error);
    }
  });

  router.post("/logout", (req, res) => {
    const sessionId = requestSessionId(req);
    const resolved = getSessionById(sessionId);
    if (resolved) {
      clearStoredToken(resolved.userRef);
      clearSession(resolved.userRef);
      logSecurityEvent("web_logout", {
        principal: maskPrincipal(resolved.userRef),
      });
    } else {
      clearSessionById(sessionId);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get("/whoami", (req, res) => {
    const auth = authenticatedUser(req);
    res.json({
      ok: true,
      authenticated: Boolean(auth),
      principal: auth ? maskPrincipal(auth.userRef) : null,
      email: auth?.session?.username ?? null,
      expires: auth?.session?.expires ?? null,
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
      if (!allowInternalRoute(req, res)) return;

      const result = await recordIntentFeedback({
        userRef: bodyString(req, "userRef", "web-ui"),
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
      if (!allowInternalRoute(req, res)) return;

      const training = await getBuildMealTrainingRuntime(optionalQueryString(req, "userRef"));
      res.json({ ok: true, training });
    } catch (error) {
      next(error);
    }
  });

  router.get("/build-meal-learning-state", async (req, res, next) => {
    try {
      if (!allowInternalRoute(req, res)) return;

      const state = await getBuildMealLearningState();
      res.json({ ok: true, ...state });
    } catch (error) {
      next(error);
    }
  });

  router.get("/build-meal-recipes", async (req, res, next) => {
    try {
      if (!allowInternalRoute(req, res)) return;

      const store = await getBuildMealUserRecipes(optionalQueryString(req, "userRef"));
      res.json({ ok: true, ...store });
    } catch (error) {
      next(error);
    }
  });

  router.post("/build-meal-recipes", async (req, res, next) => {
    try {
      if (!allowInternalRoute(req, res)) return;

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
      if (!allowInternalRoute(req, res)) return;

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
      if (!allowInternalRoute(req, res)) return;

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
      if (!allowInternalRoute(req, res)) return;

      const auth = requireAuthenticatedUser(req, res);
      if (!auth) return;

      const query = bodyString(req, "query").trim();
      const limit =
        req.body?.limit != null && Number.isFinite(Number(req.body.limit))
          ? Math.max(1, Math.min(20, Number(req.body.limit)))
          : 8;

      if (!query) {
        return res.status(400).json({ ok: false, error: "Missing query" });
      }

      const products = rankAssistantEligibleProducts(
        query,
        await getAllProducts(auth.userRef),
        limit
      );
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
      if (!allowInternalRoute(req, res)) return;

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
      const auth = requireAuthenticatedUser(req, res);
      if (!auth) return;

      const basket = await ensureCurrentBasketFutureDelivery(auth.userRef);
      res.json({ ok: true, basket });
    } catch (error) {
      next(error);
    }
  });

  router.get("/history-suggestions", async (req, res, next) => {
    try {
      const auth = requireAuthenticatedUser(req, res);
      if (!auth) return;

      const suggestions = await getNextHistorySuggestions(auth.userRef);
      res.json({ ok: true, suggestions });
    } catch (error) {
      next(error);
    }
  });

  router.post("/chat", async (req, res, next) => {
    try {
      const auth = requireAuthenticatedUser(req, res);
      if (!auth) return;

      const text = bodyString(req, "text");
      const frontendIntentHint = parseFrontendIntentHint(req.body?.frontendIntentHint);
      if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

      const output = await withPerfTrace(
        "ai.chat",
        async () => await runAgent(auth.userRef, text, frontendIntentHint),
        {
          principal: maskPrincipal(auth.userRef),
          textLength: text.length,
          frontendIntentHintAction: frontendIntentHint?.actionKey,
          frontendIntentHintConfidence: frontendIntentHint?.confidence,
        }
      );
      logSecurityEvent("web_chat", {
        principal: maskPrincipal(auth.userRef),
        actionHint: frontendIntentHint?.actionKey ?? null,
        textLength: text.length,
      });
      res.json({ ok: true, input: text, ...output });
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
