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

export function aiRoutes() {
  const r = Router();

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
      if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

      const out = await runAgent(userRef, text);
      res.json({ ok: true, userRef, input: text, ...out });
    } catch (e) {
      next(e);
    }
  });

  return r;
}