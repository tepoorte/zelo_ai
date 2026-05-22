import express from "express";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "./config/env.js";
import { rawBodySaver } from "./middleware/rawBody.js";
import { errorHandler } from "./middleware/error.js";

import { healthRouter } from "./routes/health.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { whatsappMetaRoutes } from "./integrations/meta/whatsapp.routes.js";
import { twilioWhatsAppRoutes } from "./integrations/twilio/whatsapp.routes.js";

const app = express();
app.use(morgan("dev"));

// Webhook signature checks need the original request body.
app.use(express.json({ verify: (req, res, buf) => rawBodySaver(req as any, res as any, buf) }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use("/health", healthRouter);
app.use("/ai", aiRoutes());
app.use("/integrations/meta/whatsapp", whatsappMetaRoutes());
app.use("/integrations/twilio/whatsapp", twilioWhatsAppRoutes());

app.use(errorHandler);

app.listen(env.port, "0.0.0.0", () => {
  console.log(`Zélo API démarrée sur http://0.0.0.0:${env.port}`);
});
