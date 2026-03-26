import express from "express";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "./config/env.js";
import { rawBodySaver } from "./middleware/rawBody.js";
import { errorHandler } from "./middleware/error.js";

import { healthRouter } from "./routes/health.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { webhookRoutes } from "./routes/webhook.routes.js";
import { buildCatalogEmbedding } from "./ai/meal_old/catalog-embeddings.js";

const app = express();
app.use(morgan("dev"));

// raw body per signature webhook (ok lasciarlo)
app.use(express.json({ verify: (req, res, buf) => rawBodySaver(req as any, res as any, buf) }));

// Static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

// Home -> la pagina HTML
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Routes API
app.use("/health", healthRouter);   // healthRouter.get("/") -> /health
app.use("/ai", aiRoutes());         // /ai/chat, /ai/test, ecc
app.use("/webhooks", webhookRoutes());

app.use(errorHandler);

app.listen(env.port, "0.0.0.0", () => {
  console.log(`Zelo API listening on http://0.0.0.0:${env.port}`);
    // build embeddings catalogo (background)
  buildCatalogEmbedding("local-dev", false)
    .then(() => console.log("✅ Catalog embeddings ready"))
    .catch(err => console.error("❌ Catalog embedding error:", err));
});
