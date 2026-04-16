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
import { localNlpFallback } from "../ai/meal_old/localFallback.js";
import { login } from "../swissdata/auth.js";
import { setSession, getSession } from "../swissdata/session.js";
import { getCurrentBasket } from "../swissdata/cart.js";
import { withPerfTrace } from "../utils/perf.js";
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

  r.post("/test", (req, res) => {
    const text = String(req.body?.text ?? "");
    const parsed = localNlpFallback(text);
    res.json({ ok: true, input: text, ...parsed });
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
