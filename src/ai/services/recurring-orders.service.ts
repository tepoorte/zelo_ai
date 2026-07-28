import { clearPending, getPending, setPending, type PendingRecurringOrderSummary } from "../pending.js";
import {
  listCustomerRecurringOrders,
  updateCustomerRecurringProducts,
  type CustomerRecurringOrder,
} from "../../swissdata/recurring-orders.js";
import { fetchFullProduct, type Product } from "../../swissdata/products.js";
import { computeBasketQty } from "./cart-quantity.service.js";
import { shouldAskForProductOptions } from "./cart.service.js";
import { extractAddItemsFromText, type ExtractedAddItemsPlan } from "./add-items-extractor.service.js";
import { extractClearCartPartialFromBasket } from "./clear-cart-extractor.service.js";
import {
  formatOptionQuestion,
  normalizeLooseText,
  resolveOptionsFromText,
  userChoseNoOptions,
} from "./product-options.service.js";
import { resolveProduct } from "./product-resolution.service.js";
import {
  recurringFrequencyLabel,
  recurringStatusLabel,
  recurringTargetAliases,
  resolveRecurringOrderTarget,
  type RecurringOrderTargetResolution,
} from "./recurring-order-target-resolver.service.js";
import type { AgentResponse } from "./agent-response.service.js";
import type { FrontendIntentHint } from "./planner-types.js";
import {
  fetchCurrentAssistantEligibleProduct,
  isAssistantProductEligible,
  type AssistantCurrentProductReader,
} from "../product-eligibility.js";

export type RecurringOrdersDeps = {
  listCustomerRecurringOrders: typeof listCustomerRecurringOrders;
  updateCustomerRecurringProducts: typeof updateCustomerRecurringProducts;
  extractAddItemsFromText: typeof extractAddItemsFromText;
  fetchFullProduct: typeof fetchFullProduct;
  resolveProduct: typeof resolveProduct;
  computeBasketQty: typeof computeBasketQty;
  fetchCurrentProduct?: AssistantCurrentProductReader;
};

const DEFAULT_DEPS: RecurringOrdersDeps = {
  listCustomerRecurringOrders,
  updateCustomerRecurringProducts,
  extractAddItemsFromText,
  fetchFullProduct,
  resolveProduct,
  computeBasketQty,
  fetchCurrentProduct: fetchCurrentAssistantEligibleProduct,
};

const CONFIRM_RECURRING_TEXT = "confirme la commande récurrente";

function recurringKeywordPattern(): RegExp {
  return /\b(?:commandes?\s+)?(?:r[eé]currentes?|recurrentes?|r[eé]curantes?|recurantes?|recurrantes?|r[eé]currantes?|r[eé]currences?|recurrences?|recurrances?|recurances?|recurr?ing)\b/i;
}

function hasRecurringKeyword(text: string): boolean {
  return recurringKeywordPattern().test(text);
}

function isConfirmRecurring(text: string): boolean {
  const normalized = normalizeLooseText(text);
  return normalized === normalizeLooseText(CONFIRM_RECURRING_TEXT) || isShortOk(normalized);
}

function isShortOk(text: string): boolean {
  return /^(ok|okay|d accord|d'accord|oui|yes|vas y|vas-y)$/i.test(normalizeLooseText(text));
}

function isCancel(text: string): boolean {
  return /\b(annule|annuler|annul|annull|annulla|cancel|oublie|laisse tomber|stop)\b/i.test(normalizeLooseText(text));
}

function detectOperation(text: string): "show" | "add" | "remove" {
  const normalized = normalizeLooseText(text);

  if (removeOperationPattern().test(normalized)) {
    return "remove";
  }

  if (addOperationPattern().test(normalized)) {
    return "add";
  }

  return "show";
}

type RecurringChangeOperation = "add" | "remove";

type RecurringChangeStep = {
  operation: RecurringChangeOperation;
  text: string;
};

function addOperationPattern(): RegExp {
  return /\b(ajoute|ajouter|rajoute|rajouter|mets|met|mettre|prends|prendre)\b/i;
}

function removeOperationPattern(): RegExp {
  return /\b(retire|retirer|enleve|enlever|supprime|supprimer|ote|oter|pas de|plus de|je ne veux plus|garde|gardes)\b/i;
}

function splitChangeSteps(text: string): RecurringChangeStep[] {
  const normalized = normalizeLooseText(text);
  const triggers: Array<{ index: number; operation: RecurringChangeOperation }> = [];
  const triggerPattern = /\b(ajoute|ajouter|rajoute|rajouter|mets|met|mettre|prends|prendre|retire|retirer|enleve|enlever|supprime|supprimer|ote|oter|garde|gardes)\b/gi;

  for (const match of normalized.matchAll(triggerPattern)) {
    const word = match[1] || "";
    const index = match.index ?? -1;
    if (index < 0) continue;
    triggers.push({
      index,
      operation: addOperationPattern().test(word) ? "add" : "remove",
    });
  }

  const phraseRemove = normalized.search(/\b(pas de|plus de|je ne veux plus)\b/i);
  if (phraseRemove >= 0) {
    triggers.push({ index: phraseRemove, operation: "remove" });
  }

  const sorted = triggers
    .sort((left, right) => left.index - right.index)
    .filter((trigger, index, all) => index === 0 || trigger.index !== all[index - 1]?.index);

  if (!sorted.length) return [];
  if (sorted.length === 1) return [{ operation: sorted[0].operation, text }];

  return sorted.map((trigger, index) => {
    const next = sorted[index + 1];
    const segment = normalized.slice(trigger.index, next?.index ?? normalized.length);
    return { operation: trigger.operation, text: segment };
  });
}

function dayLabel(day: number): string {
  switch (day) {
    case 0:
    case 7:
      return "dimanche";
    case 1:
      return "lundi";
    case 2:
      return "mardi";
    case 3:
      return "mercredi";
    case 4:
      return "jeudi";
    case 5:
      return "vendredi";
    case 6:
      return "samedi";
    default:
      return `jour ${day}`;
  }
}

function summarizeRecurringOrder(order: CustomerRecurringOrder): PendingRecurringOrderSummary {
  return {
    id: order.id,
    name: order.name,
    dayLabels: order.daysOfWeek.map(dayLabel),
    deliveryTime: order.deliveryTime,
    frequencyUnit: order.frequencyUnit,
    recurringOrderStatus: order.recurringOrderStatus,
    start: order.start,
    end: order.end,
    nextDates: order.nextDates,
    products: order.products.map((line) => ({
      productId: line.productId,
      name: line.name || line.productName || line.product?.name || line.productId,
      quantity: line.quantity,
    })),
  };
}

function recurringDisplayName(order: PendingRecurringOrderSummary): string {
  const rawName = String(order.name || "").replace(/^AI TEST\s*-\s*/i, "").trim();
  const firstDay = order.dayLabels[0];
  const dayPattern = "(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)";
  const recurringWithBareDay = rawName.match(new RegExp(`^commande\\s+r[eé]currente\\s+${dayPattern}$`, "i"));

  if (recurringWithBareDay?.[1]) {
    return `Commande récurrente du ${recurringWithBareDay[1].toLowerCase()}`;
  }

  if (!rawName && firstDay) {
    return `Commande récurrente du ${firstDay}`;
  }

  return rawName || "Commande récurrente";
}

function formatProducts(products: PendingRecurringOrderSummary["products"]): string {
  if (!products.length) return "• Aucun produit";
  return products
    .map((line) => `• ${line.quantity} × ${line.name}`)
    .join("\n");
}

function formatRecurringHeader(order: PendingRecurringOrderSummary, index?: number): string {
  const prefix = index != null ? `${index + 1}. ` : "";
  const displayName = recurringDisplayName(order);
  const days = order.dayLabels.length ? order.dayLabels.join(", ") : "jour non précisé";
  const time = order.deliveryTime ? ` à ${order.deliveryTime}` : "";
  const frequency = recurringFrequencyLabel(order);
  const status = recurringStatusLabel(order.recurringOrderStatus);
  const details = [
    frequency,
    status ? `statut ${status}` : "",
  ].filter(Boolean);
  const detailText = details.length ? `, ${details.join(", ")}` : "";
  const dates = order.nextDates.length ? `\n   Prochaines dates : ${order.nextDates.slice(0, 3).join(", ")}` : "";
  return `${prefix}${displayName}\n   ${days}${time}${detailText}${dates}`;
}

function formatRecurringOrdersList(orders: PendingRecurringOrderSummary[]): string {
  if (!orders.length) {
    return "Je n’ai trouvé aucune commande récurrente liée à ton compte.";
  }

  return (
    "Voici tes commandes récurrentes :\n\n" +
    orders
      .map((order, index) => `${formatRecurringHeader(order, index)}\n${formatProducts(order.products)}`)
      .join("\n\n")
  );
}

function formatRecurringOrderChoicePrompt(orders: PendingRecurringOrderSummary[]): string {
  return (
    `${formatRecurringOrdersList(orders)}\n\n` +
    `Laquelle veux-tu modifier ? Réponds avec le numéro, le nom, l’horaire, la fréquence ou une prochaine date.`
  );
}

function compactProducts(products: PendingRecurringOrderSummary["products"]): Array<{ productId: string; quantity: number }> {
  return products
    .map((line) => ({
      productId: String(line.productId || ""),
      quantity: Math.max(0, Number(line.quantity || 0)),
    }))
    .filter((line) => line.productId && line.quantity > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeLoosePhrase(text: string, normalizedPhrase: string): string {
  const words = normalizeLooseText(normalizedPhrase)
    .split(/\s+/)
    .map((word) => escapeRegExp(word))
    .filter(Boolean);
  if (!words.length) return text;
  const pattern = words.join("[\\s\\W_]+");
  return text.replace(new RegExp(`\\b${pattern}\\b`, "gi"), " ");
}

function selectedRecurringOrder(
  resolution: RecurringOrderTargetResolution
): PendingRecurringOrderSummary | null {
  return resolution.status === "selected" ? resolution.order : null;
}

function ambiguousRecurringOrders(
  resolution: RecurringOrderTargetResolution,
  fallbackOrders: PendingRecurringOrderSummary[]
): PendingRecurringOrderSummary[] {
  if (resolution.status === "ambiguous" && resolution.candidates.length) {
    return resolution.candidates.map((candidate) => candidate.order);
  }

  return fallbackOrders;
}

function sanitizeRecurringChangeText(text: string, order?: PendingRecurringOrderSummary): string {
  let cleaned = ` ${text} `;
  cleaned = cleaned.replace(recurringKeywordPattern(), " ");
  cleaned = cleaned.replace(/\b(du|de la|de l|des|le|la|les)\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, " ");
  cleaned = cleaned.replace(/\b(a|à|dans|pour|sur)\s+(ma|mes|la|les|une|des)\s+commande[s]?\b/gi, " ");
  cleaned = cleaned.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, " ");
  if (order?.name) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(order.name), "gi"), " ");
    const displayName = recurringDisplayName(order);
    cleaned = cleaned.replace(new RegExp(escapeRegExp(displayName), "gi"), " ");
  }
  if (order) {
    for (const alias of recurringTargetAliases(order)) {
      cleaned = removeLoosePhrase(cleaned, alias);
    }
  }
  cleaned = cleaned.replace(/\b(?:(?:toutes?|tous)\s+les?|chaque)\s+(?:\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:semaines?|sem\.?|mois)\b/gi, " ");
  cleaned = cleaned.replace(/\b(?:1|une?)\s+(?:sem\.?|semaine)\s+sur\s+(?:\d+|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{1,2}\s*h(?:\s*\d{2})?\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ");
  return cleaned.replace(/\s+/g, " ").trim();
}

function mergeProducts(
  current: PendingRecurringOrderSummary["products"],
  product: Product,
  quantity: number
): PendingRecurringOrderSummary["products"] {
  const productId = String(product.id);
  const existing = current.find((line) => line.productId === productId);
  if (existing) {
    return current.map((line) =>
      line.productId === productId
        ? { ...line, quantity: Math.max(1, Number(line.quantity || 0) + quantity) }
        : line
    );
  }

  return [
    ...current,
    {
      productId,
      name: product.name || productId,
      quantity: Math.max(1, quantity),
    },
  ];
}

function buildBasketLike(order: PendingRecurringOrderSummary) {
  return {
    products: order.products.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      name: line.name,
      productName: line.name,
      product: { name: line.name },
    })),
  };
}

function removalCandidates(
  text: string,
  order: PendingRecurringOrderSummary
): PendingRecurringOrderSummary["products"] {
  const normalized = normalizeLooseText(text);
  const ignored = new Set([
    "retire",
    "retirer",
    "enleve",
    "enlever",
    "supprime",
    "supprimer",
    "garde",
    "gardes",
    "de",
    "du",
    "des",
    "la",
    "le",
    "les",
    "un",
    "une",
    "dans",
  ]);
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ignored.has(token));

  if (!tokens.length) return [];

  return order.products.filter((line) => {
    const lineName = normalizeLooseText(line.name);
    return tokens.some((token) => lineName.includes(token));
  });
}

function changeSummary(
  before: PendingRecurringOrderSummary["products"],
  after: PendingRecurringOrderSummary["products"]
): string[] {
  const beforeById = new Map(before.map((line) => [line.productId, line]));
  const afterById = new Map(after.map((line) => [line.productId, line]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const lines: string[] = [];

  for (const id of ids) {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (!left && right) {
      lines.push(`• Ajout : ${right.quantity} × ${right.name}`);
    } else if (left && !right) {
      lines.push(`• Retrait : ${left.quantity} × ${left.name}`);
    } else if (left && right && left.quantity !== right.quantity) {
      lines.push(`• ${right.name} : ${left.quantity} → ${right.quantity}`);
    }
  }

  return lines;
}

function formatConfirmationPrompt(
  order: PendingRecurringOrderSummary,
  before: PendingRecurringOrderSummary["products"],
  after: PendingRecurringOrderSummary["products"],
  changes: string[]
): AgentResponse {
  const displayName = recurringDisplayName(order);
  return {
    message:
      `Je prépare la modification de « ${displayName} ».\n\n` +
      `Changements proposés :\n${changes.length ? changes.join("\n") : "• Aucun changement détecté"}\n\n` +
      `Avant :\n${formatProducts(before)}\n\n` +
      `Après :\n${formatProducts(after)}\n\n` +
      `Pour appliquer, écris « ok » ou « ${CONFIRM_RECURRING_TEXT} ».\n` +
      `Si tu ne veux pas modifier la commande récurrente, écris « annule ».`,
  };
}

async function buildAddChange(
  userRef: string,
  text: string,
  order: PendingRecurringOrderSummary,
  deps: RecurringOrdersDeps,
  resolvedOptionsProductId?: string
): Promise<{
  after: PendingRecurringOrderSummary["products"];
  errors: string[];
  pendingOptionsProduct?: Product;
}> {
  const cleaned = sanitizeRecurringChangeText(text, order);
  const plan: ExtractedAddItemsPlan = await deps.extractAddItemsFromText(userRef, cleaned);
  const items = plan.actions[0]?.items ?? [];
  const askForOptions = shouldAskForProductOptions(items.length);
  let after = [...order.products];
  const errors: string[] = [];

  for (const item of items) {
    const product = item.productId
      ? await deps.fetchFullProduct(userRef, item.productId)
      : await deps.resolveProduct(userRef, item.query);

    if (!product?.id || !isAssistantProductEligible(product)) {
      errors.push(`• ${item.query} : introuvable ou indisponible`);
      continue;
    }

    if (
      askForOptions &&
      product.id !== resolvedOptionsProductId &&
      Array.isArray(product.optionsIds) &&
      product.optionsIds.length > 0
    ) {
      if (Array.isArray(product.availableOptions) && product.availableOptions.length > 0) {
        return { after, errors, pendingOptionsProduct: product };
      }
      errors.push(`• ${product.name} : options indisponibles, non ajouté à la récurrente`);
      continue;
    }

    const quantity = deps.computeBasketQty(product, item.qty, item.unit);
    after = mergeProducts(after, product, Math.max(1, quantity));
  }

  return { after, errors };
}

async function recurringIncreasesAreEligible(
  userRef: string,
  before: PendingRecurringOrderSummary["products"],
  after: PendingRecurringOrderSummary["products"],
  deps: RecurringOrdersDeps
): Promise<boolean> {
  const beforeQuantityById = new Map<string, number>();
  for (const line of before) {
    const productId = String(line.productId || "").trim();
    if (!productId) continue;
    beforeQuantityById.set(
      productId,
      (beforeQuantityById.get(productId) || 0) + Math.max(0, Number(line.quantity || 0))
    );
  }

  const afterQuantityById = new Map<string, number>();
  for (const line of after) {
    const productId = String(line.productId || "").trim();
    if (!productId) continue;
    afterQuantityById.set(
      productId,
      (afterQuantityById.get(productId) || 0) + Math.max(0, Number(line.quantity || 0))
    );
  }

  for (const [productId, afterQuantity] of afterQuantityById) {
    if (afterQuantity <= (beforeQuantityById.get(productId) || 0)) continue;
    const product = await (deps.fetchCurrentProduct ?? deps.fetchFullProduct)(userRef, productId);
    if (!product || !isAssistantProductEligible(product)) return false;
  }

  return true;
}

function buildRemoveChange(
  text: string,
  order: PendingRecurringOrderSummary
): { after: PendingRecurringOrderSummary["products"]; errors: string[] } {
  const cleaned = sanitizeRecurringChangeText(text, order);
  const extraction = extractClearCartPartialFromBasket(cleaned, buildBasketLike(order), []);
  let after = [...order.products];
  const errors: string[] = [];

  for (const item of extraction.items) {
    const productId = String(item.line?.productId ?? "");
    if (!productId) continue;
    const current = after.find((line) => line.productId === productId);
    if (!current) continue;

    if (item.operation === "set_exact") {
      const target = Math.max(0, Number(item.targetQuantity ?? current.quantity));
      after = target <= 0
        ? after.filter((line) => line.productId !== productId)
        : after.map((line) => line.productId === productId ? { ...line, quantity: target } : line);
      continue;
    }

    if (item.operation === "decrease") {
      const amount = Math.max(0, Number(item.quantity ?? current.quantity));
      const target = Math.max(0, current.quantity - amount);
      after = target <= 0
        ? after.filter((line) => line.productId !== productId)
        : after.map((line) => line.productId === productId ? { ...line, quantity: target } : line);
      continue;
    }

    after = after.filter((line) => line.productId !== productId);
  }

  if (!extraction.items.length) {
    const candidates = removalCandidates(cleaned, order);
    const displayName = recurringDisplayName(order);
    if (candidates.length > 1) {
      errors.push(
        `J’ai trouvé plusieurs produits possibles dans « ${displayName} » :\n` +
        candidates.map((line) => `• ${line.quantity} × ${line.name}`).join("\n") +
        `\nPrécise lequel retirer, par exemple avec son nom complet.`
      );
    } else {
      errors.push(`Je n’ai pas reconnu clairement le produit à retirer dans « ${displayName} ».`);
    }
  }

  return { after, errors };
}

async function prepareRecurringChange(
  userRef: string,
  text: string,
  order: PendingRecurringOrderSummary,
  deps: RecurringOrdersDeps,
  resolvedOptionsProductId?: string
): Promise<AgentResponse> {
  const operation = detectOperation(text);
  const displayName = recurringDisplayName(order);

  if (operation === "show") {
    setPending(userRef, {
      type: "awaiting_recurring_order_change",
      recurringOrder: order,
    });
    return {
      message:
        `Tu veux modifier « ${displayName} ».\n\n` +
        `Produits actuels :\n${formatProducts(order.products)}\n\n` +
        `Écris par exemple « ajoute du pain » ou « retire le lait ».`,
    };
  }

  const steps = splitChangeSteps(text);
  if (!steps.length) {
    return {
      message:
        `Je n’ai pas identifié de modification sûre à appliquer à « ${displayName} ».\n` +
        `Tu peux reformuler avec le produit exact, par exemple « ajoute du pain » ou « retire le lait ».`,
    };
  }

  const before = [...order.products];
  let after = before;
  const errors: string[] = [];

  for (const step of steps) {
    const stepOrder = { ...order, products: after };
    const result = step.operation === "add"
      ? await buildAddChange(userRef, step.text, stepOrder, deps, resolvedOptionsProductId)
      : buildRemoveChange(step.text, stepOrder);
    const pendingOptionsProduct = "pendingOptionsProduct" in result
      ? result.pendingOptionsProduct as Product | undefined
      : undefined;
    if (pendingOptionsProduct) {
      const product = pendingOptionsProduct;
      setPending(userRef, {
        type: "awaiting_recurring_product_options",
        recurringOrder: order,
        originalText: text,
        productId: product.id,
        productName: product.name,
        availableOptions: product.availableOptions!.map((option) => ({
          id: option.id,
          name: option.name || "Option",
          shortDescription: option.shortDescription,
          description: option.description,
        })),
      });
      return { message: formatOptionQuestion(product) };
    }
    after = result.after;
    errors.push(...result.errors);
  }
  const changes = changeSummary(before, after);

  if (!changes.length) {
    return {
      message:
        (errors.length ? `${errors.join("\n")}\n\n` : "") +
        `Je n’ai pas identifié de modification sûre à appliquer à « ${displayName} ».\n` +
        `Tu peux reformuler avec le produit exact, par exemple « ajoute du pain » ou « retire le lait ».`,
    };
  }

  setPending(userRef, {
    type: "awaiting_recurring_order_confirmation",
    recurringOrder: order,
    beforeProducts: before,
    afterProducts: after,
    changes: [...changes, ...errors],
  });

  return formatConfirmationPrompt(order, before, after, [...changes, ...errors]);
}

export async function tryHandleRecurringOrders(
  userRef: string,
  userText: string,
  _intentHint?: FrontendIntentHint,
  deps: RecurringOrdersDeps = DEFAULT_DEPS
): Promise<AgentResponse | null> {
  const pending = getPending(userRef);

  if (pending?.type === "awaiting_recurring_product_options") {
    if (isCancel(userText)) {
      clearPending(userRef);
      return { message: "D’accord, je n’ai pas modifié ta commande récurrente." };
    }

    const choseNoOptions = userChoseNoOptions(userText, pending.availableOptions);
    const selected = resolveOptionsFromText(userText, pending.availableOptions);

    if (!selected.length && !choseNoOptions) {
      return {
        message:
          `Je n’ai pas reconnu les options demandées pour « ${pending.productName} ».\n\n` +
          formatOptionQuestion({
            id: pending.productId,
            name: pending.productName,
            availableOptions: pending.availableOptions,
          }),
      };
    }

    const currentProduct = await fetchCurrentAssistantEligibleProduct(
      userRef,
      pending.productId,
      deps.fetchCurrentProduct ?? deps.fetchFullProduct
    );
    if (!currentProduct) {
      clearPending(userRef);
      return {
        message:
          "Ce produit n’est plus disponible via l’Assistant Zélo. " +
          "La commande récurrente n’a pas été modifiée.",
      };
    }

    clearPending(userRef);
    return await prepareRecurringChange(
      userRef,
      pending.originalText,
      pending.recurringOrder,
      deps,
      pending.productId
    );
  }

  if (pending?.type === "awaiting_recurring_order_confirmation") {
    if (isCancel(userText)) {
      clearPending(userRef);
      return { message: "D’accord, je n’ai pas modifié ta commande récurrente." };
    }

    if (!isConfirmRecurring(userText)) {
      return {
        message: `Je garde la modification en attente. Pour l’appliquer, écris « ok » ou « ${CONFIRM_RECURRING_TEXT} », ou « annule ».`,
      };
    }

    if (!await recurringIncreasesAreEligible(
      userRef,
      pending.beforeProducts,
      pending.afterProducts,
      deps
    )) {
      clearPending(userRef);
      return {
        message:
          "La modification contient un produit indisponible via l’Assistant Zélo. " +
          "La commande récurrente n’a pas été modifiée.",
      };
    }

    const updated = await deps.updateCustomerRecurringProducts(
      userRef,
      pending.recurringOrder.id,
      compactProducts(pending.afterProducts)
    );
    clearPending(userRef);
    const summary = summarizeRecurringOrder(updated);
    const displayName = recurringDisplayName(summary);
    return {
      message:
        `✅ Commande récurrente mise à jour : « ${displayName} ».\n\n` +
        `Produits maintenant prévus :\n${formatProducts(summary.products)}`,
    };
  }

  if (pending?.type === "awaiting_recurring_order_choice") {
    if (isCancel(userText)) {
      clearPending(userRef);
      return { message: "D’accord, je n’ai pas modifié tes commandes récurrentes." };
    }

    const resolution = resolveRecurringOrderTarget(userText, pending.recurringOrders);
    const selected = selectedRecurringOrder(resolution);
    if (!selected) {
      const choices = ambiguousRecurringOrders(resolution, pending.recurringOrders);
      return {
        message:
          `Je n’ai pas reconnu quelle commande récurrente modifier.\n\n` +
          `${formatRecurringOrderChoicePrompt(choices)}`,
      };
    }

    clearPending(userRef);
    return await prepareRecurringChange(userRef, pending.originalText, selected, deps);
  }

  if (pending?.type === "awaiting_recurring_order_change") {
    if (isCancel(userText)) {
      clearPending(userRef);
      return { message: "D’accord, je n’ai pas modifié ta commande récurrente." };
    }
    return await prepareRecurringChange(userRef, userText, pending.recurringOrder, deps);
  }

  if (!hasRecurringKeyword(userText)) {
    return null;
  }

  const orders = (await deps.listCustomerRecurringOrders(userRef)).map(summarizeRecurringOrder);
  const operation = detectOperation(userText);

  if (!orders.length) {
    return {
      message:
        "Je n’ai trouvé aucune commande récurrente liée à ton compte.\n" +
        "Pour l’instant, je peux seulement modifier une commande récurrente existante.",
    };
  }

  if (operation === "show") {
    return { message: formatRecurringOrdersList(orders) };
  }

  const resolution = resolveRecurringOrderTarget(userText, orders);
  const selected = selectedRecurringOrder(resolution);
  if (!selected) {
    const choices = ambiguousRecurringOrders(resolution, orders);
    setPending(userRef, {
      type: "awaiting_recurring_order_choice",
      originalText: userText,
      recurringOrders: choices,
    });
    return { message: formatRecurringOrderChoicePrompt(choices) };
  }

  return await prepareRecurringChange(userRef, userText, selected, deps);
}
