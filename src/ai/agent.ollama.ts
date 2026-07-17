import { getAllProducts } from "../swissdata/products.js";
import { timeAsync, perfMeta } from "../utils/perf.js";
import { BuildMealEngine } from "./build-meal/engine.js";
import { rankAssistantEligibleProducts } from "./product-eligibility.js";
import { clearPending, getPending } from "./pending.js";
import { systemPrompt } from "./prompts.js";
import { extractAddItemsFromText } from "./services/add-items-extractor.service.js";
import {
  formatAddItemsResponse,
  formatBuildMealResult,
  formatClearCartResponse,
  formatDiscoverMealResponse,
  formatExecCartResponse,
  formatNoClearProductResponse,
  type AgentResponse,
} from "./services/agent-response.service.js";
import { formatCartFr } from "./services/cart-format.service.js";
import {
  handleAddToCartAction,
  handleClearCartAction,
  handleExecCartAction,
  handleShowCartAction,
  tryResolvePendingOptions,
} from "./services/cart.service.js";
import { handleDiscoverMealIdeasAction } from "./services/meal-discovery.service.js";
import { ollamaChat } from "./services/ollama-client.js";
import {
  planUserIntent,
} from "./services/planner.service.js";
import { tryHandleRecurringOrders } from "./services/recurring-orders.service.js";
import type {
  FrontendIntentHint,
  Plan,
  PlannedAction,
} from "./services/planner-types.js";

type ToolResult = {
  action: PlannedAction;
  result: any;
};

// BuildMeal is intentionally silenced for the customer flow while the intent
// router is trained on the four main routes. To re-enable it: set this flag to
// true and add `build_meal` back to the active intent training/model.
const BUILD_MEAL_FLOW_ENABLED = false;

function isExplicitShowCartRequest(normalizedText: string): boolean {
  return /(carrello|basket|panier|cart)/i.test(normalizedText) &&
    /(montre|mostra|show|voir)/i.test(normalizedText);
}

function isExplicitAddItemsRequest(normalizedText: string): boolean {
  return /\b(ajoute|ajouter|rajoute|mets|met|commande|commander|besoin|prends|prendre|livrer|livraison)\b/i.test(normalizedText) ||
    /\b(il me faut|il faudrait|je veux bien|je te prends|j aurais besoin|j ai besoin)\b/i.test(normalizedText);
}

async function handleForcedAddItems(userRef: string, userText: string): Promise<AgentResponse> {
  clearPending(userRef);

  const directPlan = await timeAsync(
    "agent.extract_add_items_direct",
    async () => await extractAddItemsFromText(userRef, userText),
    { userText }
  );
  const directAction = directPlan.actions[0];

  if (!directAction.items.length) {
    return formatNoClearProductResponse();
  }

  const addOutcome = await timeAsync(
    "agent.action.add_to_cart_direct",
    async () => await handleAddToCartAction(userRef, directAction),
    { items: directAction.items.length }
  );

  if (addOutcome.pending) {
    return { message: addOutcome.message };
  }

  return formatAddItemsResponse(addOutcome.result);
}

async function handleBuildMeal(userRef: string, userText: string, force: boolean): Promise<AgentResponse | null> {
  const result = force
    ? await timeAsync(
        "agent.action.build_meal_direct",
        async () => await BuildMealEngine.handleBuildMealFromText(userRef, userText),
        { userText }
      )
    : await timeAsync(
        "agent.action.build_meal_detected",
        async () => await BuildMealEngine.tryHandleDetectedRequest(userRef, userText),
        { userText }
      );

  return result ? await formatBuildMealResult(userRef, result) : null;
}

async function executePlannedAction(
  userRef: string,
  action: PlannedAction,
  userText: string
): Promise<ToolResult | AgentResponse> {
  if (action.type === "search_products") {
    const result = await timeAsync(
      "agent.action.search_products",
      async () => rankAssistantEligibleProducts(
        action.query,
        await getAllProducts(userRef),
        action.limit ?? 5
      ),
      { query: action.query, limit: action.limit ?? 5 }
    );
    return { action, result };
  }

  if (action.type === "add_to_cart") {
    const addOutcome = await timeAsync(
      "agent.action.add_to_cart",
      async () => await handleAddToCartAction(userRef, action),
      { items: action.items.length }
    );

    if (addOutcome.pending) {
      return { message: addOutcome.message };
    }

    return { action, result: addOutcome.result };
  }

  if (action.type === "get_cart") {
    const result = await timeAsync(
      "agent.action.get_cart",
      async () => await handleShowCartAction(userRef, action)
    );
    return { action, result };
  }

  if (action.type === "clear_cart") {
    const result = await timeAsync(
      "agent.action.clear_cart",
      async () => await handleClearCartAction(userRef, action, userText)
    );
    return { action, result };
  }

  if (action.type === "exec_cart") {
    const result = await timeAsync(
      "agent.action.exec_cart",
      async () => await handleExecCartAction(userRef, action)
    );
    return { action, result };
  }

  if (action.type === "discover_meal_ideas") {
    const result = await timeAsync(
      "agent.action.discover_meal_ideas",
      async () => await handleDiscoverMealIdeasAction(userRef, action.query ?? userText, {
        needHints: action.needHints,
        roleHints: action.roleHints,
        focusTerms: action.focusTerms,
        constraints: action.constraints,
      })
    );
    return { action, result };
  }

  return { action, result: { ok: true } };
}

async function runPlannedActions(
  userRef: string,
  actions: PlannedAction[],
  userText: string
): Promise<ToolResult[] | AgentResponse> {
  const toolResults: ToolResult[] = [];

  for (const action of actions) {
    const output = await executePlannedAction(userRef, action, userText);
    if ("message" in output) {
      return output;
    }
    toolResults.push(output);
  }

  return toolResults;
}

function formatControlledNoopResponse(intentHint?: FrontendIntentHint): AgentResponse {
  if (intentHint?.actionKey && intentHint.actionKey !== "noop") {
    return {
      message:
        "Je ne suis pas assez sûr d’avoir compris l’action à faire. Peux-tu reformuler plus directement ? Par exemple : « ajoute ... », « montre mon panier », « vide mon panier » ou « propose-moi une idée ... ».",
    };
  }

  return {
    message:
      "Je suis là. Tu peux me demander d’ajouter des produits, de voir ou vider ton panier, ou de te proposer des idées.",
  };
}

async function handleMissingPlan(userRef: string, normalizedText: string, intentHint?: FrontendIntentHint): Promise<AgentResponse> {
  if (/(carrello|basket|panier|cart)/i.test(normalizedText)) {
    const basket = await timeAsync(
      "agent.show_cart_fallback",
      async () => await handleShowCartAction(userRef)
    );
    return { message: formatCartFr(basket) };
  }

  return formatControlledNoopResponse(intentHint);
}

function findToolResult(toolResults: ToolResult[], type: PlannedAction["type"]): any {
  return toolResults.find((entry) => entry.action?.type === type)?.result;
}

function formatPlannedIntentResponse(plan: Plan, toolResults: ToolResult[]): AgentResponse | null {
  if (findToolResult(toolResults, "get_cart")) {
    return { message: formatCartFr(findToolResult(toolResults, "get_cart")) };
  }

  if (findToolResult(toolResults, "clear_cart")) {
    return formatClearCartResponse(findToolResult(toolResults, "clear_cart"));
  }

  if (findToolResult(toolResults, "add_to_cart")) {
    return formatAddItemsResponse(findToolResult(toolResults, "add_to_cart"));
  }

  if (findToolResult(toolResults, "exec_cart")) {
    return formatExecCartResponse(findToolResult(toolResults, "exec_cart"));
  }

  if (findToolResult(toolResults, "discover_meal_ideas")) {
    return formatDiscoverMealResponse(findToolResult(toolResults, "discover_meal_ideas"));
  }

  return null;
}

async function writeNaturalFallback(plan: Plan, toolResults: ToolResult[], userRef: string, userText: string): Promise<AgentResponse> {
  const message = await ollamaChat(
    [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
      { role: "assistant", content: `PLAN: ${JSON.stringify(plan)}` },
      { role: "assistant", content: `TOOL_RESULTS: ${JSON.stringify(toolResults)}` },
      {
        role: "user",
        content:
          "Réponds UNIQUEMENT en français. Tutoie toujours l’utilisateur : utilise tu/ton, jamais vous/votre/vos. Confirme ce que tu as compris et ce que tu as ajouté au panier, ou ce qui manque.",
      },
    ],
    0.4
  );

  return { message: message || "Ok." };
}

export async function runAgentOllama(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<AgentResponse> {
  perfMeta({ userRef, userTextPreview: userText.slice(0, 80) });

  const normalizedText = userText.toLowerCase();
  const forceAddItems = intentHint?.actionKey === "add_items";
  const pending = getPending(userRef);

  if (pending?.type === "awaiting_options" && isExplicitAddItemsRequest(normalizedText)) {
    clearPending(userRef);
  }

  const pendingOptionReply = await timeAsync(
    "agent.pending_options",
    async () => await tryResolvePendingOptions(userRef, userText)
  );
  if (pendingOptionReply) {
    return pendingOptionReply;
  }

  const recurringOrdersReply = await timeAsync(
    "agent.recurring_orders",
    async () => await tryHandleRecurringOrders(userRef, userText, intentHint)
  );
  if (recurringOrdersReply) {
    return recurringOrdersReply;
  }

  if (isExplicitShowCartRequest(normalizedText)) {
    const basket = await timeAsync(
      "agent.show_cart_deterministic",
      async () => await handleShowCartAction(userRef)
    );
    return { message: formatCartFr(basket) };
  }

  if (forceAddItems) {
    return await handleForcedAddItems(userRef, userText);
  }

  if (BUILD_MEAL_FLOW_ENABLED && intentHint?.actionKey === "build_meal") {
    const response = await handleBuildMeal(userRef, userText, true);
    if (response) return response;
  }

  if (BUILD_MEAL_FLOW_ENABLED) {
    const detectedMealResponse = await handleBuildMeal(userRef, userText, false);
    if (detectedMealResponse) {
      return detectedMealResponse;
    }
  }

  const plan = await timeAsync(
    "agent.plan_user_intent",
    async () => await planUserIntent(userRef, userText, intentHint)
  );

  if (!plan || !Array.isArray(plan.actions)) {
    return await handleMissingPlan(userRef, normalizedText, intentHint);
  }

  if (plan.intent === "NOOP" || plan.actions.some((action) => action.type === "noop")) {
    // Keep NOOP as a valid route, but do not fall back to free-form chat here:
    // specialized planners may return NOOP when they refuse an action, and a
    // generic LLM answer can invent behavior outside the routed flow.
    return formatControlledNoopResponse(intentHint);
  }

  const toolResults = await runPlannedActions(userRef, plan.actions, userText);
  if ("message" in toolResults) {
    return toolResults;
  }

  return formatPlannedIntentResponse(plan, toolResults) ??
    await writeNaturalFallback(plan, toolResults, userRef, userText);
}
