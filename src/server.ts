import express from "express";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertProductionEnv, env } from "./config/env.js";
import { rawBodySaver } from "./middleware/rawBody.js";
import { errorHandler } from "./middleware/error.js";
import { installProductionConsoleRedaction } from "./utils/console-redaction.js";
import { redactSensitive, safeError } from "./utils/redaction.js";

import { healthRouter } from "./routes/health.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import { whatsappMetaRoutes } from "./integrations/meta/whatsapp.routes.js";
import { whatsappOnboardingRoutes } from "./integrations/meta/whatsapp-onboarding.routes.js";
import { whatsappWebRoutes } from "./integrations/meta/whatsapp-web.routes.js";
import { startWhatsAppWebSession } from "./integrations/meta/whatsapp-web.service.js";
import { twilioWhatsAppRoutes } from "./integrations/twilio/whatsapp.routes.js";

installProductionConsoleRedaction();
assertProductionEnv();

const app = express();
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const accessLogOptions = {
  skip: (req: express.Request) => env.nodeEnv === "production" && req.path === "/health",
  ...(env.nodeEnv === "production"
    ? {
        stream: {
          write(message: string) {
            process.stdout.write(redactSensitive(message));
          },
        },
      }
    : {}),
};

app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev", accessLogOptions));

// Webhook signature checks need the original request body.
app.use(express.json({ verify: (req, res, buf) => rawBodySaver(req as any, res as any, buf) }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sendWhatsAppOnboardingPage(_req: express.Request, res: express.Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.sendFile(path.join(__dirname, "..", "public", "inscription-whatsapp.html"));
}

// Register both paths before express.static so the security headers cannot be
// bypassed by requesting the physical .html file directly.
app.get(["/inscription-whatsapp", "/inscription-whatsapp.html"], sendWhatsAppOnboardingPage);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use("/health", healthRouter);
app.use("/ai", aiRoutes());
app.use("/integrations/meta/whatsapp/onboarding", whatsappOnboardingRoutes());
app.use("/integrations/meta/whatsapp", whatsappMetaRoutes());
if (env.whatsappProvider === "web_session") {
  app.use("/integrations/meta/whatsapp-web", whatsappWebRoutes());
}
if (env.whatsappProvider === "twilio") {
  app.use("/integrations/twilio/whatsapp", twilioWhatsAppRoutes());
}

app.use(errorHandler);

app.listen(env.port, "0.0.0.0", () => {
  console.log(`Zélo API démarrée sur http://0.0.0.0:${env.port}`);
  if (env.whatsappProvider === "web_session") {
    void startWhatsAppWebSession().catch((error) => {
      console.error("[whatsapp-web] startup failed", safeError(error));
    });
  }
});
