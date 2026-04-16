// src/ai/agent.ollama.ts
//import { env } from "../config/env.js";
import { runGeneralChat } from "./services/chat.service.js";
import { ollamaChat} from "./services/ollama-client.js";
import {
  formatCartFr
  //,resolveProduct,
  //computeBasketQty,
  //formatOptionQuestion,
  //resolveOptionsFromText,
} from "./services/cart-helpers.service.js";
import { systemPrompt } from "./prompts.js";
import { searchProducts } from "../swissdata/products.js";

import {
  tryResolvePendingOptions,
  handleAddToCartAction,
  handleShowCartAction,
  handleClearCartAction,
  handleExecCartAction,
} from "./services/cart.service.js";
import {
  handleDiscoverMealIdeasAction,
  tryResolvePendingMealDiscovery,
} from "./services/meal-discovery.service.js";
//import { handleBuildMealAction } from "./services/meal.service.js";
//import { handleBuildMealActionV2 } from "./services/meal.service.v2.js";
import { MealBuildEngineV2 } from "./MealBuildEngine.v2.js";
//import { MealBuildEngineV3 } from "./MealBuildEngineV3.js";
import { planUserIntent, type FrontendIntentHint } from "./services/planner.service.js";
import { timeAsync, perfMeta } from "../utils/perf.js";









export async function runAgentOllama(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<{ message: string }> {
  perfMeta({ userRef, userTextPreview: userText.slice(0, 80) });
  const lower = userText.toLowerCase();

const pendingMealDiscoveryReply = await timeAsync(
  "agent.pending_meal_discovery",
  async () => await tryResolvePendingMealDiscovery(userRef, userText)
);
if (pendingMealDiscoveryReply) {
  return pendingMealDiscoveryReply;
}

const pendingReply = await timeAsync(
  "agent.pending_options",
  async () => await tryResolvePendingOptions(userRef, userText)
);
if (pendingReply) {
  return pendingReply;
}

  // 1) SHOW CART deterministic
if (/(carrello|basket|panier|cart)/i.test(lower) && /(montre|mostra|show|voir)/i.test(lower)) {
  const basket = await timeAsync(
    "agent.show_cart_deterministic",
    async () => await handleShowCartAction(userRef)
  );
  return { message: formatCartFr(basket) };
}

  // 2) PLAN with Ollama for everything shopping-related

  const plan = await timeAsync(
    "agent.plan_user_intent",
    async () => await planUserIntent(userRef, userText, intentHint)
  );
  
  /*const planText = await ollamaChat(
    [
      { role: "system", content: plannerPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
    ],
    0.2
  );
  */

  if (!plan || !Array.isArray(plan.actions)) {
    if (/(carrello|basket|panier|cart)/i.test(lower)) {
      const basket = await timeAsync(
        "agent.show_cart_fallback",
        async () => await handleShowCartAction(userRef)
      );
      return { message: formatCartFr(basket) };
    }

    return await timeAsync(
      "agent.general_chat",
      async () => await runGeneralChat(userRef, userText)
    );
  }

  if (
    plan.intent === "NOOP" ||
    plan.actions.some((action) => action.type === "noop")
  ) {
    return await timeAsync(
      "agent.general_chat_noop",
      async () => await runGeneralChat(userRef, userText)
    );
  }

  const toolResults: any[] = [];

  for (const action of plan.actions) {
    if (action.type === "search_products") {
      const r = await timeAsync(
        "agent.action.search_products",
        async () => await searchProducts(userRef, action.query, action.limit ?? 5),
        { query: action.query, limit: action.limit ?? 5 }
      );
      toolResults.push({ action, result: r });
      continue;
    }

if (action.type === "add_to_cart") {
  const addOutcome = await timeAsync(
    "agent.action.add_to_cart",
    async () => await handleAddToCartAction(userRef, action),
    { items: action.items.length }
  );

  if (addOutcome.pending === true) {
    return { message: addOutcome.message };
  }

  toolResults.push({
    action,
    result: addOutcome.result,
  });

  continue;
}

if (action.type === "get_cart") {
  const r = await timeAsync(
    "agent.action.get_cart",
    async () => await handleShowCartAction(userRef, action)
  );
  toolResults.push({ action, result: r });
  continue;
}

if (action.type === "clear_cart") {
  const result = await timeAsync(
    "agent.action.clear_cart",
    async () => await handleClearCartAction(userRef, action)
  );
  toolResults.push({ action, result });
  continue;
}

if (action.type === "exec_cart") {
  const result = await timeAsync(
    "agent.action.exec_cart",
    async () => await handleExecCartAction(userRef, action)
  );
  toolResults.push({ action, result });
  continue;
}

if (action.type === "discover_meal_ideas") {
  const result = await timeAsync(
    "agent.action.discover_meal_ideas",
    async () => await handleDiscoverMealIdeasAction(userRef)
  );
  toolResults.push({ action, result });
  continue;
}


    if (action.type === "build_meal") {

        // PROVVISORY// //const result = await handleBuildMealAction(userRef, action);
        //const result = await handleBuildMealActionV2(userRef, action);


        const result = await timeAsync(
  "agent.action.build_meal",
  async () => await MealBuildEngineV2.handleBuildMeal(userRef, {
  type: "build_meal",
  meal: action.meal,
  servings: action.servings
}),
  { meal: action.meal, servings: action.servings }
);

   //const result = await MealBuildEngineV3.handleBuildMeal(userRef, action);
  toolResults.push({
    action,
    result,
  });
     
      continue;
    }





    toolResults.push({ action, result: { ok: true } });
  }

  if (plan.intent === "SHOW_CART") {
    const cartResult = toolResults.find((x) => x.action?.type === "get_cart")?.result;
    return { message: formatCartFr(cartResult) };
  }
  if (plan.intent === "CLEAR_CART") {
  const clearResult = toolResults.find(
    (x) => x.action?.type === "clear_cart"
  )?.result;

  if (clearResult?.mode === "partial") {
    const removedItems = Array.isArray(clearResult?.removedItems) ? clearResult.removedItems : [];
    const unmatchedQueries = Array.isArray(clearResult?.unmatchedQueries) ? clearResult.unmatchedQueries : [];

    if (!removedItems.length) {
      return {
        message:
          `Je n’ai pas trouvé clairement l’article à retirer dans votre panier.\n\n` +
          formatCartFr(clearResult?.basket),
      };
    }

    const lines = removedItems.map(
      (item: any) => `• ${item?.quantity ?? 1} × ${item?.name ?? "Produit"}`
    );

    const unmatchedBlock = unmatchedQueries.length
      ? `\n\nJe n’ai pas retrouvé clairement :\n${unmatchedQueries.map((q: string) => `• ${q}`).join("\n")}`
      : "";

    return {
      message:
        `🧹 J’ai retiré du panier :\n` +
        lines.join("\n") +
        unmatchedBlock +
        `\n\n` +
        formatCartFr(clearResult?.basket),
    };
  }

  return {
    message:
      `🧹 J’ai vidé votre panier.\n\n` +
      formatCartFr(clearResult?.basket),
  };
}

if (plan.intent === "ADD_ITEMS") {
  const addResult = toolResults.find((x) => x.action?.type === "add_to_cart")?.result;
  const basket = addResult?.basket;

  const summaryLines: string[] = [];

  if (Array.isArray(addResult?.resolvedItems)) {
    for (const it of addResult.resolvedItems) {
      if (it.ok) {
        summaryLines.push(
          `— ${it.requestedQty}${it.requestedUnit && it.requestedUnit !== "piece" ? it.requestedUnit : ""} de ${it.product?.name ?? it.query} → quantité panier: ${it.targetBasketQty ?? it.basketQty ?? "?"}`
        );
      } else {
        summaryLines.push(`— ${it.query} : introuvable`);
      }
    }
  }

  if (!summaryLines.length) {
    return {
      message: "Je n’ai pas trouvé de produit suffisamment clair à ajouter. Essaie avec un nom plus précis, par exemple « Courses pour 2 » ou « Courses pour 4 »."
    };
  }

  return {
    message:
      `✅ J’ai traité votre demande :\n` +
      summaryLines.join("\n") +
      `\n\n` +
      (basket ? formatCartFr(basket) : "Le panier a été mis à jour, mais je n’ai pas pu relire son contenu.")
  };
}

if (plan.intent === "EXEC_CART") {
  const execResult = toolResults.find(
    (x) => x.action?.type === "exec_cart"
  )?.result;

  if (!execResult?.ok) {
    return {
      message: "Je n’ai pas réussi à passer la commande.",
    };
  }

  const orderId =
    execResult?.order?.id ??
    execResult?.order?._id ??
    execResult?.order?.orderNb ??
    null;

  return {
    message:
      `✅ J’ai bien passé la commande.` +
      (orderId ? `\nRéférence: ${orderId}` : ""),
  };
}

if (plan.intent === "DISCOVER_MEALS") {
  const discoverResult = toolResults.find(
    (x) => x.action?.type === "discover_meal_ideas"
  )?.result;

  return {
    message:
      discoverResult?.message ??
      "Je peux vous proposer quelques idees par categorie alimentaire.",
  };
}

if (plan.intent === "BUILD_MEAL") {
  const mealResult = toolResults.find(
    (x) => x.action?.type === "build_meal"
  )?.result;

  if (!mealResult) {
    return {
      message: "Je n’ai pas réussi à préparer les ingrédients pour ce repas.",
    };
  }

  if (!mealResult.ok) {
    const missingLines: string[] = [];

    if (Array.isArray(mealResult.resolvedItems)) {
      for (const it of mealResult.resolvedItems) {
        if (!it.ok && !it.isCore) {
          missingLines.push(`— ${it.query}`);
        }
      }
    }

    const alternatives = Array.isArray(mealResult.alternatives)
      ? mealResult.alternatives
      : [];

    return {
      message:
        `Je ne trouve pas tous les ingrédients nécessaires pour « ${mealResult.meal} ».\n` +
        (missingLines.length ? `\nIl me manque notamment :\n${missingLines.join("\n")}\n` : "\n") +
        (alternatives.length
          ? `\nJe peux te proposer plutôt :\n${alternatives.map((a: string) => `— ${a}`).join("\n")}`
          : ""),
    };
  }

  const lines: string[] = [];

  for (const it of mealResult.resolvedItems) {
    if (it.ok) {
      lines.push(`— ${it.product?.name ?? it.query}`);
    }
  }

  return {
    message:
      `🍽️ J’ai ajouté des ingrédients pour préparer « ${mealResult.meal} » :\n` +
      lines.join("\n") +
      `\n\n` +
      formatCartFr(mealResult.basket),
  };
}


  const message = await ollamaChat(
    [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
      { role: "assistant", content: `PLAN: ${JSON.stringify(plan)}` },
      { role: "assistant", content: `TOOL_RESULTS: ${JSON.stringify(toolResults)}` },
      {
        role: "user",
        content:
          "Réponds UNIQUEMENT en français. Confirme ce que tu as compris et ce que tu as ajouté au panier, ou ce qui manque.",
      },
    ],
    0.4
  );

  return { message: message || "Ok." };
}
