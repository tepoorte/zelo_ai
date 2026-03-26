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
//import { handleBuildMealAction } from "./services/meal.service.js";
//import { handleBuildMealActionV2 } from "./services/meal.service.v2.js";
import { MealBuildEngineV2 } from "./MealBuildEngine.v2.js";
//import { MealBuildEngineV3 } from "./MealBuildEngineV3.js";
import { planUserIntent } from "./services/planner.service.js";










export async function runAgentOllama(
  userRef: string,
  userText: string
): Promise<{ message: string }> {
  const lower = userText.toLowerCase();

const pendingReply = await tryResolvePendingOptions(userRef, userText);
if (pendingReply) {
  return pendingReply;
}

  // 1) SHOW CART deterministic
if (/(carrello|basket|panier|cart)/i.test(lower) && /(montre|mostra|show|voir)/i.test(lower)) {
  const basket = await handleShowCartAction(userRef);
  return { message: formatCartFr(basket) };
}

  // 2) PLAN with Ollama for everything shopping-related

  const plan = await planUserIntent(userRef, userText);
  
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
      const basket = await handleShowCartAction(userRef);
      return { message: formatCartFr(basket) };
    }

    return await runGeneralChat(userRef, userText);
  }

  const toolResults: any[] = [];

  for (const action of plan.actions) {
    if (action.type === "search_products") {
      const r = await searchProducts(userRef, action.query, action.limit ?? 5);
      toolResults.push({ action, result: r });
      continue;
    }

if (action.type === "add_to_cart") {
  const addOutcome = await handleAddToCartAction(userRef, action);

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
  const r = await handleShowCartAction(userRef, action);
  toolResults.push({ action, result: r });
  continue;
}

if (action.type === "clear_cart") {
  const result = await handleClearCartAction(userRef, action);
  toolResults.push({ action, result });
  continue;
}

if (action.type === "exec_cart") {
  const result = await handleExecCartAction(userRef, action);
  toolResults.push({ action, result });
  continue;
}


    if (action.type === "build_meal") {

        // PROVVISORY// //const result = await handleBuildMealAction(userRef, action);
        //const result = await handleBuildMealActionV2(userRef, action);


        const result = await MealBuildEngineV2.handleBuildMeal(userRef, {
  type: "build_meal",
  meal: action.meal,
  servings: action.servings
});

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
