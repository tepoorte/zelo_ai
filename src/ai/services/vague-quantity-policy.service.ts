import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import { fetchProductById, type Product } from "../../swissdata/products.js";

export type VagueQuantityCue = "des" | "quelque";

export type VagueQuantityPolicyItem = {
  query: string;
  qty: number;
  unit?: string;
  productId?: string;
  vagueQuantityCue?: VagueQuantityCue;
};

type VagueQuantityPolicyPlan<T extends VagueQuantityPolicyItem> = {
  intent: "ADD_ITEMS";
  actions: [
    {
      type: "add_to_cart";
      items: T[];
    },
  ];
};

export type VagueQuantityProductResolver = (
  userRef: string,
  productId: string
) => Promise<Product | null>;

const DEFAULT_VAGUE_QUANTITY = 3;
const EXPENSIVE_PRODUCT_QUANTITY = 1;
const EXPENSIVE_PRODUCT_PRICE_CHF = 10;

const FIXED_QUANTITY_BY_PRODUCT_TOKEN: Array<{
  tokens: string[];
  qty: number;
}> = [
  { tokens: ["oeuf", "oeufs"], qty: 8 },
  { tokens: ["pomme", "pommes"], qty: 1 },
  { tokens: ["poire", "poires"], qty: 1 },
  { tokens: ["carotte", "carottes"], qty: 1 },
  { tokens: ["poireau", "poireaux"], qty: 1 },
];

function numericPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

export function extractProductPriceCHF(product: Product | null | undefined): number | null {
  if (!product) return null;

  const directPrice = numericPrice(product.price);
  if (directPrice != null) return directPrice;

  const priceObject = product.price && typeof product.price === "object" ? product.price : null;
  const objectPrice =
    numericPrice(priceObject?.discount) ??
    numericPrice(priceObject?.price) ??
    numericPrice(priceObject?.amountCHF);
  if (objectPrice != null) return objectPrice;

  if (product.countryPrices && typeof product.countryPrices === "object") {
    for (const countryPrice of Object.values(product.countryPrices)) {
      if (!countryPrice || typeof countryPrice !== "object") continue;
      const price =
        numericPrice((countryPrice as any).discount) ??
        numericPrice((countryPrice as any).price);
      if (price != null) return price;
    }
  }

  return null;
}

function fixedVagueQuantityForProduct(item: VagueQuantityPolicyItem): number | null {
  const tokenSet = new Set([
    ...tokenizeForMatch(item.query),
    ...tokenizeForMatch(normalizeText(item.query)),
  ]);

  for (const rule of FIXED_QUANTITY_BY_PRODUCT_TOKEN) {
    if (rule.tokens.some((token) => tokenSet.has(token))) {
      return rule.qty;
    }
  }

  return null;
}

function stripInternalFields(item: VagueQuantityPolicyItem): VagueQuantityPolicyItem {
  const { vagueQuantityCue: _vagueQuantityCue, ...publicItem } = item;
  return publicItem;
}

async function resolveVagueQuantity(
  userRef: string,
  item: VagueQuantityPolicyItem,
  resolveProduct: VagueQuantityProductResolver
): Promise<number> {
  const fixedQuantity = fixedVagueQuantityForProduct(item);
  if (fixedQuantity != null) return fixedQuantity;

  if (!item.productId) return DEFAULT_VAGUE_QUANTITY;

  try {
    const product = await resolveProduct(userRef, item.productId);
    const priceCHF = extractProductPriceCHF(product);
    if (priceCHF != null && priceCHF > EXPENSIVE_PRODUCT_PRICE_CHF) {
      return EXPENSIVE_PRODUCT_QUANTITY;
    }
  } catch (error) {
    console.warn("[VAGUE_QUANTITY_POLICY] product price lookup failed", {
      productId: item.productId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return DEFAULT_VAGUE_QUANTITY;
}

export async function applyVagueQuantityPolicyToPlan<T extends VagueQuantityPolicyItem>(
  userRef: string,
  plan: VagueQuantityPolicyPlan<T>,
  resolveProduct: VagueQuantityProductResolver = fetchProductById
): Promise<VagueQuantityPolicyPlan<VagueQuantityPolicyItem>> {
  const adjustedItems = await Promise.all(
    plan.actions[0].items.map(async (item) => {
      if (!item.vagueQuantityCue || item.unit !== "piece" || item.qty !== 1) {
        return stripInternalFields(item);
      }

      return {
        ...stripInternalFields(item),
        qty: await resolveVagueQuantity(userRef, item, resolveProduct),
      };
    })
  );

  return {
    intent: "ADD_ITEMS",
    actions: [
      {
        type: "add_to_cart",
        items: adjustedItems,
      },
    ],
  };
}
