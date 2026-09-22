import { Router, type NextFunction, type Request, type Response } from "express";

import {
  WhatsAppOnboardingError,
  type WhatsAppOnboardingService,
  whatsappOnboardingService,
} from "./whatsapp-onboarding.service.js";

function tokenFrom(req: Request): string {
  return typeof req.body?.token === "string" ? req.body.token : "";
}

function onboardingHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
}

function sendOnboardingError(error: unknown, res: Response): void {
  if (error instanceof WhatsAppOnboardingError) {
    if (error.retryAfterSeconds) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    res.status(error.httpStatus).json({
      ok: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  console.error("[whatsapp-onboarding] request failed");
  res.status(503).json({
    ok: false,
    code: "temporarily_unavailable",
    message: "Le service est temporairement indisponible. Réessaie dans quelques minutes.",
  });
}

type OnboardingRouteService = Pick<
  WhatsAppOnboardingService,
  "status" | "regions" | "start" | "resend" | "complete" | "connect"
>;

export function whatsappOnboardingRoutes(
  service: OnboardingRouteService = whatsappOnboardingService
): Router {
  const router = Router();
  router.use(onboardingHeaders);

  router.post("/status", async (req, res) => {
    try {
      res.json(await service.status(tokenFrom(req)));
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  router.post("/regions", async (req, res) => {
    try {
      res.json(await service.regions(tokenFrom(req)));
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  router.post("/start", async (req, res) => {
    try {
      res.json(
        await service.start({
          token: tokenFrom(req),
          firstname: typeof req.body?.firstname === "string" ? req.body.firstname : "",
          lastname: typeof req.body?.lastname === "string" ? req.body.lastname : "",
          email: typeof req.body?.email === "string" ? req.body.email : "",
          address: {
            street:
              typeof req.body?.address?.street === "string" ? req.body.address.street : "",
            zip: typeof req.body?.address?.zip === "string" ? req.body.address.zip : "",
            city: typeof req.body?.address?.city === "string" ? req.body.address.city : "",
            country:
              typeof req.body?.address?.country === "string" ? req.body.address.country : "",
          },
          regionId: typeof req.body?.regionId === "string" ? req.body.regionId : "",
          password: typeof req.body?.password === "string" ? req.body.password : "",
          termsAccepted: req.body?.termsAccepted === true,
        })
      );
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  router.post("/resend", async (req, res) => {
    try {
      res.json(await service.resend(tokenFrom(req)));
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      res.json(
        await service.complete({
          token: tokenFrom(req),
          emailCode: typeof req.body?.emailCode === "string" ? req.body.emailCode : "",
          password: typeof req.body?.password === "string" ? req.body.password : "",
        })
      );
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  router.post("/connect", async (req, res) => {
    try {
      res.json(
        await service.connect({
          token: tokenFrom(req),
          email: typeof req.body?.email === "string" ? req.body.email : "",
          password: typeof req.body?.password === "string" ? req.body.password : "",
        })
      );
    } catch (error) {
      sendOnboardingError(error, res);
    }
  });

  return router;
}
