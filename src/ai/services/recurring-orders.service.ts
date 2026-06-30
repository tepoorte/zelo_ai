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
import { normalizeLooseText } from "./product-options.service.js";
import { resolveProduct } from "./product-resolution.service.js";
import type { AgentResponse } from "./agent-response.service.js";
import type { FrontendIntentHint } from "./planner-types.js";

export type RecurringOrdersDeps = {
  listCustomerRecurringOrders: typeof listCustomerRecurringOrders;
  updateCustomerRecurringProducts: typeof updateCustomerRecurringProducts;
  extractAddItemsFromText: typeof extractAddItemsFromText;
  fetchFullProduct: typeof fetchFullProduct;
  resolveProduct: typeof resolveProduct;
  computeBasketQty: typeof computeBasketQty;
};

const DEFAULT_DEPS: RecurringOrdersDeps = {
  listCustomerRecurringOrders,
  updateCustomerRecurringProducts,
  extractAddItemsFromText,
  fetchFullProduct,
  resolveProduct,
  computeBasketQty,
};

const CONFIRM_RECURRING_TEXT = "confirme la commande récurrente";

function recurringKeywordPattern(): RegExp {
  return /\b(?:commandes?\s+)?(?:r[eé]currentes?|recurrentes?|r[eé]curantes?|recurantes?|recurrantes?|r[eé]currantes?|recurr?ing)\b/i;
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
  return /\b(annule|annuler|cancel|oublie|laisse tomber|stop)\b/i.test(normalizeLooseText(text));
}

function detectOperation(text: string): "show" | "add" | "remove" {
  const normalized = normalizeLooseText(text);

  if (/\b(retire|retirer|enleve|enlever|supprime|supprimer|ote|ôter|pas de|plus de|je ne veux plus|garde|gardes)\b/i.test(normalized)) {
    return "remove";
  }

  if (/\b(ajoute|ajouter|rajoute|rajouter|mets|met|mettre|prends|prendre)\b/i.test(normalized)) {
    return "add";
  }

  return "show";
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
  const dates = order.nextDates.length ? `\n   Prochaines dates : ${order.nextDates.slice(0, 3).join(", ")}` : "";
  return `${prefix}${displayName}\n   ${days}${time}${dates}`;
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

function compactProducts(products: PendingRecurringOrderSummary["products"]): Array<{ productId: string; quantity: number }> {
  return products
    .map((line) => ({
      productId: String(line.productId || ""),
      quantity: Math.max(0, Number(line.quantity || 0)),
    }))
    .filter((line) => line.productId && line.quantity > 0);
}

function normalizeIndexChoice(text: string): number | null {
  const normalized = normalizeLooseText(text);
  const numeric = normalized.match(/\b([1-9][0-9]?)\b/);
  if (numeric) return Number(numeric[1]) - 1;

  const words: Record<string, number> = {
    un: 0,
    une: 0,
    premier: 0,
    premiere: 0,
    deux: 1,
    deuxieme: 1,
    second: 1,
    seconde: 1,
    trois: 2,
    troisieme: 2,
    quatre: 3,
    quatrieme: 3,
    cinq: 4,
    cinquieme: 4,
  };

  for (const [word, index] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return index;
  }

  return null;
}

function selectRecurringOrder(
  text: string,
  orders: PendingRecurringOrderSummary[]
): PendingRecurringOrderSummary | null {
  if (orders.length === 1) return orders[0];

  const normalized = normalizeLooseText(text);
  const selectedIndex = normalizeIndexChoice(text);
  if (selectedIndex != null && orders[selectedIndex]) {
    return orders[selectedIndex];
  }

  const dayMatches = orders.filter((order) =>
    order.dayLabels.some((label) => new RegExp(`\\b${normalizeLooseText(label)}\\b`).test(normalized))
  );
  if (dayMatches.length === 1) return dayMatches[0];

  const nameMatches = orders.filter((order) => {
    const names = [order.name, recurringDisplayName(order)]
      .map((name) => normalizeLooseText(name))
      .filter(Boolean);
    return names.some((normalizedName) => normalized.includes(normalizedName) || normalizedName.includes(normalized));
  });
  if (nameMatches.length === 1) return nameMatches[0];

  return null;
}

function sanitizeRecurringChangeText(text: string, order?: PendingRecurringOrderSummary): string {
  let cleaned = ` ${text} `;
  cleaned = cleaned.replace(recurringKeywordPattern(), " ");
  cleaned = cleaned.replace(/\b(du|de la|de l|des|le|la|les)\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, " ");
  cleaned = cleaned.replace(/\b(a|à|dans|pour|sur)\s+(ma|mes|la|les|une|des)\s+commande[s]?\b/gi, " ");
  cleaned = cleaned.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, " ");
  if (order?.name) {
    cleaned = cleaned.replace(new RegExp(order.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    const displayName = recurringDisplayName(order);
    cleaned = cleaned.replace(new RegExp(displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
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
  deps: RecurringOrdersDeps
): Promise<{ after: PendingRecurringOrderSummary["products"]; errors: string[] }> {
  const cleaned = sanitizeRecurringChangeText(text, order);
  const plan: ExtractedAddItemsPlan = await deps.extractAddItemsFromText(userRef, cleaned);
  const items = plan.actions[0]?.items ?? [];
  const askForOptions = shouldAskForProductOptions(items.length);
  let after = [...order.products];
  const errors: string[] = [];

  for (const item of items) {
    const product = item.productId
      ? await deps.fetchFullProduct(userRef, item.productId) ?? ({ id: item.productId, name: item.query || item.productId } as Product)
      : await deps.resolveProduct(userRef, item.query);

    if (!product?.id) {
      errors.push(`• ${item.query} : introuvable`);
      continue;
    }

    if (askForOptions && Array.isArray(product.optionsIds) && product.optionsIds.length > 0) {
      errors.push(`• ${product.name} : options nécessaires, non ajouté à la récurrente`);
      continue;
    }

    const quantity = deps.computeBasketQty(product, item.qty, item.unit);
    after = mergeProducts(after, product, Math.max(1, quantity));
  }

  return { after, errors };
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
  deps: RecurringOrdersDeps
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

  const before = [...order.products];
  const { after, errors } = operation === "add"
    ? await buildAddChange(userRef, text, order, deps)
    : buildRemoveChange(text, order);
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

    const selected = selectRecurringOrder(userText, pending.recurringOrders);
    if (!selected) {
      return {
        message:
          `Je n’ai pas reconnu quelle commande récurrente modifier.\n\n` +
          `${formatRecurringOrdersList(pending.recurringOrders)}\n\n` +
          `Réponds avec le numéro ou le jour, par exemple « mardi ».`,
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

  const selected = selectRecurringOrder(userText, orders);
  if (!selected) {
    setPending(userRef, {
      type: "awaiting_recurring_order_choice",
      originalText: userText,
      recurringOrders: orders,
    });
    return {
      message:
        `${formatRecurringOrdersList(orders)}\n\n` +
        `Laquelle veux-tu modifier ? Réponds avec le numéro ou le jour, par exemple « mardi ».`,
    };
  }

  return await prepareRecurringChange(userRef, userText, selected, deps);
}
