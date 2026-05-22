import type { Plan, PlannedAction } from "./planner-types.js";
import {
  fallbackDiscoverPlannerVocabulary,
  normalizeDiscoverPlannerChoices,
} from "../discover/planner-vocabulary.js";

function normalizeUnit(value: unknown): string | undefined {
  const unit = String(value ?? "").trim().toLowerCase();
  if (!unit) return undefined;

  if (unit === "piece" || unit === "pieces" || unit === "piece(s)" || unit === "pièce" || unit === "pièces") {
    return "piece";
  }
  if (
    unit === "g" ||
    unit === "gr" ||
    unit === "gram" ||
    unit === "grams" ||
    unit === "gramme" ||
    unit === "grammes" ||
    unit === "grain" ||
    unit === "grains"
  ) {
    return "g";
  }
  if (unit === "kg" || unit === "kilogramme" || unit === "kilogrammes") {
    return "kg";
  }
  if (unit === "l" || unit === "litre") return "litre";
  if (unit === "litres") return "litres";
  if (unit === "ml") return "ml";
  return undefined;
}

function parseLooseNumber(value: string): number | undefined {
  const normalized = String(value || "").trim().replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractInlineQuantity(rawQuery: string): {
  query: string;
  qty?: number;
  unit?: string;
} {
  const query = String(rawQuery ?? "").trim().replace(/\s+/g, " ");
  if (!query) return { query: "" };

  const unitPattern =
    "(kg|kilogrammes?|g|gr|grammes?|grams?|grains?|ml|l|litres?|pieces?|piece\\(s\\)|pi[eè]ces?)";

  const prefixWithUnit = query.match(
    new RegExp(`^(\\d+(?:[\\.,]\\d+)?)\\s*${unitPattern}\\s+(?:de\\s+|du\\s+|des\\s+|d['’]\\s*)?(.+)$`, "i")
  );
  if (prefixWithUnit) {
    return {
      query: prefixWithUnit[3].trim(),
      qty: parseLooseNumber(prefixWithUnit[1]),
      unit: normalizeUnit(prefixWithUnit[2]),
    };
  }

  const suffixWithUnit = query.match(
    new RegExp(`^(.+?)\\s+(\\d+(?:[\\.,]\\d+)?)\\s*${unitPattern}$`, "i")
  );
  if (suffixWithUnit) {
    return {
      query: suffixWithUnit[1].trim(),
      qty: parseLooseNumber(suffixWithUnit[2]),
      unit: normalizeUnit(suffixWithUnit[3]),
    };
  }

  const prefixNumberOnly = query.match(/^(\d+(?:[\.,]\d+)?)\s+(?:de\s+|du\s+|des\s+|d['’]\s*)?(.+)$/i);
  if (prefixNumberOnly) {
    return {
      query: prefixNumberOnly[2].trim(),
      qty: parseLooseNumber(prefixNumberOnly[1]),
      unit: "piece",
    };
  }

  const suffixNumberOnly = query.match(/^(.+?)\s+(\d+(?:[\.,]\d+)?)$/i);
  if (suffixNumberOnly) {
    return {
      query: suffixNumberOnly[1].trim(),
      qty: parseLooseNumber(suffixNumberOnly[2]),
      unit: "piece",
    };
  }

  return { query };
}

function normalizePlannedItem(item: any): {
  query: string;
  qty: number;
  unit?: string;
  productId?: string;
} | null {
  const rawQuery = String(item?.query ?? item?.raw ?? "").trim();
  const extracted = extractInlineQuantity(rawQuery);
  const normalizedUnit = normalizeUnit(item?.unit);
  const normalizedQty = Number(item?.qty ?? 1);

  const finalQuery = extracted.query || rawQuery;
  const finalUnit = extracted.unit ?? normalizedUnit ?? "piece";
  const finalQty =
    extracted.qty != null && Number.isFinite(extracted.qty) && extracted.qty > 0
      ? extracted.qty
      : Number.isFinite(normalizedQty) && normalizedQty > 0
        ? normalizedQty
        : 1;

  if (!finalQuery) return null;

  return {
    query: finalQuery,
    qty: finalQty,
    unit: finalUnit,
    ...(item?.productId ? { productId: String(item.productId) } : {}),
  };
}

function normalizePlannedAction(action: any): PlannedAction | null {
  if (!action || typeof action !== "object") return null;

  if (action.type === "discover_meal_ideas" || action.type === "DISCOVER_MEALS") {
    const normalizedHints = normalizeDiscoverPlannerChoices(
      {
        needs: action.needHints ?? action.needs,
        roles: action.roleHints ?? action.roles,
      },
      fallbackDiscoverPlannerVocabulary()
    );

    return {
      type: "discover_meal_ideas",
      userRef: action.userRef,
      ...(action.query != null ? { query: String(action.query) } : {}),
      ...(normalizedHints.needs.length ? { needHints: normalizedHints.needs } : {}),
      ...(normalizedHints.roles.length ? { roleHints: normalizedHints.roles } : {}),
      ...(Array.isArray(action.focusTerms)
        ? { focusTerms: action.focusTerms.map((item: any) => String(item)).filter(Boolean).slice(0, 8) }
        : {}),
      ...(Array.isArray(action.constraints)
        ? { constraints: action.constraints.map((item: any) => String(item)).filter(Boolean).slice(0, 8) }
        : {}),
    };
  }

  if (action.type === "add_to_cart" && Array.isArray(action.items)) {
    return {
      type: "add_to_cart",
      userRef: action.userRef,
      items: action.items
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => normalizePlannedItem(item))
        .filter((item: any) => item.query && Number.isFinite(item.qty) && item.qty > 0),
    };
  }

  return action as PlannedAction;
}

export function normalizePlan(parsed: Plan | null): Plan | null {
  if (!parsed) return null;

  const normalizedActions = Array.isArray(parsed.actions)
    ? parsed.actions
        .map((action) => normalizePlannedAction(action))
        .filter(Boolean) as PlannedAction[]
    : [];

  if (parsed.intent === "DISCOVER_MEALS" && normalizedActions.length === 0) {
    normalizedActions.push({ type: "discover_meal_ideas" });
  }

  const mergedActions: PlannedAction[] = [];
  const mergedAddItems: Array<{
    query: string;
    qty: number;
    unit?: string;
    productId?: string;
  }> = [];
  let mergedAddUserRef: string | undefined;

  for (const action of normalizedActions) {
    if (action.type === "add_to_cart") {
      mergedAddUserRef = mergedAddUserRef ?? action.userRef;
      mergedAddItems.push(...action.items);
      continue;
    }

    mergedActions.push(action);
  }

  if (mergedAddItems.length) {
    mergedActions.unshift({
      type: "add_to_cart",
      ...(mergedAddUserRef ? { userRef: mergedAddUserRef } : {}),
      items: mergedAddItems,
    });
  }

  return {
    ...parsed,
    actions: mergedActions,
  };
}

export function normalizePlannerUserText(userText: string): string {
  return String(userText || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[•●▪◦◉∙‣⁃◾◽]/g, "\n- ")
    .replace(/\n\s*-\s*/g, "\n- ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n[ ]+/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
