import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { env } from "../src/config/env.js";
import { aiRoutes } from "../src/routes/ai.routes.js";

type IntentTrainingResponse = {
  ok?: boolean;
  training?: {
    intents?: Array<{ key?: string }>;
  };
};

type IntentClassifier = {
  predict(text: string): { actionKey?: string };
};

type RouteResult = {
  status: number;
  body: unknown;
};

async function classifierFromTraining(training: unknown): Promise<IntentClassifier> {
  const source = await fs.readFile(
    path.join(process.cwd(), "public", "predictor", "intent-classifier.js"),
    "utf-8"
  );
  const context: any = { window: {}, console };
  vm.createContext(context);
  vm.runInContext(source, context, {
    filename: "public/predictor/intent-classifier.js",
  });
  return await context.window.ZeloIntentClassifier.create(training);
}

async function invokeRoute(
  router: any,
  method: "get" | "post",
  routePath: string,
  body: Record<string, unknown> = {}
): Promise<RouteResult> {
  const routeLayer = router.stack.find((layer: any) =>
    layer.route?.path === routePath && layer.route?.methods?.[method]
  );
  assert(routeLayer, `Missing ${method.toUpperCase()} ${routePath}`);

  const handlerLayer = routeLayer.route.stack.find((layer: any) => layer.method === method);
  assert(handlerLayer?.handle, `Missing handler for ${method.toUpperCase()} ${routePath}`);

  let status = 200;
  let responseBody: unknown;
  let nextError: unknown;
  const req = {
    body,
    query: {},
    headers: {},
    header() {
      return undefined;
    },
  };
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      responseBody = payload;
      return this;
    },
    sendStatus(code: number) {
      status = code;
      responseBody = code;
      return this;
    },
  };

  await handlerLayer.handle(req, res, (error: unknown) => {
    nextError = error;
  });
  if (nextError) throw nextError;

  return { status, body: responseBody };
}

async function main(): Promise<void> {
  const originalNodeEnv = env.nodeEnv;
  env.nodeEnv = "production";

  try {
    const router = aiRoutes();
    const trainingResponse = await invokeRoute(router, "get", "/intent-training");
    assert.equal(trainingResponse.status, 200);

    const body = trainingResponse.body as IntentTrainingResponse;
    assert.equal(body.ok, true);
    assert(Array.isArray(body.training?.intents));
    assert(body.training?.intents?.some((intent) => intent.key === "add_items"));

    const classifier = await classifierFromTraining(body.training);
    assert.equal(classifier.predict("ajoute du pain").actionKey, "add_items");

    const feedbackResponse = await invokeRoute(
      router,
      "post",
      "/intent-feedback",
      {
        text: "ajoute du pain",
        predictedAction: "add_items",
        correctAction: "add_items",
        kind: "positive",
      }
    );
    assert.equal(feedbackResponse.status, 404);

    const internalTrainingResponse = await invokeRoute(router, "get", "/build-meal-training");
    assert.equal(internalTrainingResponse.status, 404);

    console.log("intent-production-route.test.ts passed");
  } finally {
    env.nodeEnv = originalNodeEnv;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
