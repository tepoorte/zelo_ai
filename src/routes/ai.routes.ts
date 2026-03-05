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
import { localNlpFallback } from "../ai/localFallback.js";

export function aiRoutes() {
  const r = Router();

  // MOCK (no OpenAI): utile per test locali anche senza chiave
  r.post("/test", (req, res) => {
    const text = String(req.body?.text ?? "");
    const parsed = localNlpFallback(text);
    res.json({ ok: true, input: text, ...parsed });
  });

  // REALE (OpenAI): prova end-to-end dell’agent
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