import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import type { Product } from "../../swissdata/products.js";
import { CATEGORY_NAME_BY_ID, EXCLUDED_CATEGORY_IDS, FOOD_CATEGORY_IDS, PREPARED_CATEGORY_IDS } from "../food-taxonomy.js";
import type {
  DiscoverNeedLabel,
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverTrainingArtifacts,
} from "./types.js";

const FOOD_CATEGORY_SET = new Set<string>([
  ...FOOD_CATEGORY_IDS.map(String),
  ...PREPARED_CATEGORY_IDS.map(String),
  "5dea5c3d7e6ac104dac9fde2",
]);

const NON_DISCOVERY_DEFAULT_CATEGORY_SET = new Set<string>([
  ...EXCLUDED_CATEGORY_IDS.map(String),
  "5f718b85d9f31d00075c9899",
]);

function categoryNames(product: Product): string[] {
  return (product.categories ?? [])
    .map((id) => CATEGORY_NAME_BY_ID[String(id)] ?? "")
    .filter(Boolean);
}

function metadataText(product: Product): string {
  return (product.metadata ?? [])
    .map((item) => `${item.key} ${String(item.value ?? "")}`)
    .join(" ");
}

function metadataBoolean(product: Product, key: string): boolean {
  const found = (product.metadata ?? []).find(
    (item) => normalizeText(item.key) === normalizeText(key)
  );
  const value = found?.value;
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

function metadataNumber(product: Product, key: string): number {
  const found = (product.metadata ?? []).find(
    (item) => normalizeText(item.key) === normalizeText(key)
  );
  const value = Number(found?.value);
  return Number.isFinite(value) ? value : 0;
}

function addRole(roles: Set<DiscoverProductRole>, role: DiscoverProductRole): void {
  roles.add(role);
}

function addLabel(labels: Set<DiscoverNeedLabel>, label: DiscoverNeedLabel): void {
  labels.add(label);
}

function applyCategoryRoles(product: Product, roles: Set<DiscoverProductRole>): void {
  const categories = new Set((product.categories ?? []).map(String));

  for (const category of categories) {
    const name = CATEGORY_NAME_BY_ID[category] ?? "";

    if (name.includes("lait")) addRole(roles, "dairy");
    if (name.includes("boulangerie")) addRole(roles, "bakery");
    if (name.includes("fruits")) addRole(roles, "vegetable");
    if (name.includes("farines")) addRole(roles, "grain");
    if (name.includes("feculents")) addRole(roles, "starch");
    if (name.includes("viande")) addRole(roles, "protein");
    if (name.includes("epices")) addRole(roles, "condiment");
    if (name.includes("boissons")) addRole(roles, "drink");
    if (name.includes("menus")) addRole(roles, "prepared_meal");
    if (name.includes("cosmetiques")) addRole(roles, "hygiene");
    if (name.includes("menage")) addRole(roles, "cleaning");
  }
}

function applyCompositeRoles(product: Product, roles: Set<DiscoverProductRole>): void {
  const categories = new Set((product.categories ?? []).map(String));
  const hasMeatFish = categories.has("5dcfdf0e6f4a93324a0a2b22");
  const hasDairy = categories.has("5dcfc1616f4a93324a0a2b1a");
  const hasBakery = categories.has("5dcfddcb6f4a93324a0a2b1e");
  const hasMenu = categories.has("5f00d2cda5761c0007833362");
  const text = normalizeText(product.name);

  if (hasMeatFish && !hasDairy) {
    roles.delete("cheese");
    roles.delete("dairy");
  }

  if (
    roles.has("fruit") &&
    roles.has("vegetable") &&
    !/\b(pomme de terre|patate|pdt|salade|legume|legumes|carotte|tomate|courgette|asperge|chou|rhubarbe|bette)\b/.test(text)
  ) {
    roles.delete("vegetable");
  }
  if (/\b(pomme de terre|patate|pdt)\b/.test(text)) {
    roles.delete("fruit");
  }
  if (/\b(plantes?\s+aromatiques?|aromatique)\b/.test(text)) {
    roles.add("condiment");
    roles.delete("fruit");
    roles.delete("vegetable");
  }

  if (hasMenu || (hasMeatFish && hasBakery) || /\b(sandwich|panini|naan|bagnat|pate vaudois|pates vaudois|pate artisanal|chinois)\b/.test(text)) {
    roles.add("prepared_meal").add("menu");
  }
}

function applyNameRoles(product: Product, roles: Set<DiscoverProductRole>): void {
  const text = normalizeText(`${product.name} ${product.tags?.join(" ") ?? ""}`);
  const has = (pattern: RegExp) => pattern.test(text);

  if (has(/\b(oeuf|oeufs)\b/)) roles.add("egg").add("protein").add("breakfast");
  if (has(/\b(lait|yaourt|yogourt|yoghourt|brebis)\b/)) roles.add("dairy").add("breakfast");
  if (has(/\b(fromage|gruyere|crottin|mozzarella|raclette)\b/)) roles.add("cheese").add("dairy").add("protein").add("aperitif");
  if (has(/\b(pain|baguette|toast|bun)\b/)) roles.add("bread").add("bakery");
  if (has(/\b(muesli|cereale|cereales|granola|flocon)\b/)) roles.add("grain").add("breakfast");
  if (has(/\b(riz|pates|pasta|maccheroni|spaghetti|fusilli|penne|polenta|semoule)\b/)) roles.add("starch").add("grain").add("pantry");
  if (has(/\b(pomme de terre|patate|pdt)\b/)) roles.add("starch").add("vegetable");
  if (has(/\b(pomme|pommes|poire|poires|fraise|fraises|figue|figues|ananas|orange|oranges|citron|citrons|banane|bananes|mangue|mangues|raisin|raisins|cranberr|fruit|fruits)\b/)) roles.add("fruit");
  if (has(/\b(salade|legume|legumes|carotte|tomate|courgette|asperge|chou|rhubarbe|bette)\b/)) roles.add("vegetable");
  if (has(/\b(poulet|boeuf|porc|veau|dinde|lard|jambon|saucisse|salami|viande|pates? vaudois|pate artisanal)\b/)) {
    roles.add("meat").add("protein");
  }
  if (has(/\b(poisson|perche|perches|brochet|fera)\b/)) roles.add("fish").add("protein");
  if (has(/\b(tofu|lentille|pois chiche|haricot)\b/)) roles.add("protein");
  if (has(/\b(sauce|ketchup|moutarde|mayonnaise|salvis|lulu)\b/)) roles.add("sauce").add("condiment");
  if (has(/\b(huile|vinaigre)\b/)) roles.add("oil").add("condiment");
  if (has(/\b(sel|poivre|epice|epices)\b/)) roles.add("condiment").add("pantry");
  if (has(/\b(pizza|menu|plat|pannette)\b/)) roles.add("prepared_meal").add("menu");
  if (has(/\b(chocolat|sorbet|glace|tarte|tartes|tartelette|tartelettes|gateau|biscuit|cookie|dessert|sucre|miel)\b/)) roles.add("dessert").add("sweet");
  if (has(/\b(biere|vin|cidre|alcool)\b/)) roles.add("alcohol").add("drink");
  if (has(/\b(jus|sirop|biere|vin|cidre|cafe|the|boisson)\b/)) roles.add("drink");
  if (has(/\b(chips|aperitif|apero|cacahuete|noix|olive)\b/)) roles.add("aperitif").add("snack");
  if (has(/\b(panier|corbeille)\b/)) roles.add("basket");
  if (has(/\b(cadeau|coffret|bouquet)\b/)) roles.add("gift");
  if (has(/\b(savon|shampoing|dentifrice|cosmetique|hygiene)\b/)) roles.add("hygiene");
  if (has(/\b(menage|lessive|nettoyant|eponge|sac poubelle|vaisselle)\b/)) roles.add("cleaning");
}

function isGenericBundleProduct(product: Product): boolean {
  const text = normalizeText(`${product.name} ${product.shortDescription ?? ""}`);
  return /\b(offre|panier|courses?|decouverte|surprise|zelodarite|zelodarité)\b/.test(text);
}

function applyTrainingRoles(
  product: Product,
  training: DiscoverTrainingArtifacts,
  roles: Set<DiscoverProductRole>,
  labels: Set<DiscoverNeedLabel>
): void {
  const productName = normalizeText(product.name);

  for (const example of training.productRoles) {
    const idMatches = example.productId && String(product.id) === String(example.productId);
    const nameMatches = example.name && productName.includes(normalizeText(example.name));
    if (!idMatches && !nameMatches) continue;

    for (const role of example.roles) roles.add(role);
    for (const label of example.labels ?? []) labels.add(label);
  }
}

function applyMetadataLabels(product: Product, labels: Set<DiscoverNeedLabel>): void {
  const tags = (product.tags ?? []).map((tag) => normalizeText(tag));
  const meta = normalizeText(metadataText(product));

  if (tags.includes("bio") || meta.includes("bio")) addLabel(labels, "healthy");
  if (tags.includes("apero") || tags.includes("apero")) addLabel(labels, "aperitif");
  if (tags.includes("sans gluten")) addLabel(labels, "healthy");
  if (metadataBoolean(product, "Fresh")) addLabel(labels, "healthy");
  if (metadataNumber(product, "Local") >= 4 || meta.includes("local")) addLabel(labels, "local");
  if (meta.includes("zero") || meta.includes("waste") || meta.includes("sparedwaste")) addLabel(labels, "zero_waste");
}

function isFoodProduct(product: Product): boolean {
  const categories = new Set((product.categories ?? []).map(String));
  if ([...categories].some((category) => NON_DISCOVERY_DEFAULT_CATEGORY_SET.has(category))) {
    return [...categories].some((category) => FOOD_CATEGORY_SET.has(category));
  }

  return [...categories].some((category) => FOOD_CATEGORY_SET.has(category)) || !categories.size;
}

export function profileProduct(
  product: Product,
  training: DiscoverTrainingArtifacts
): DiscoverProductProfile {
  const modelProfile = training.model?.productProfiles?.[String(product.id)];
  const roles = new Set<DiscoverProductRole>();
  const labels = new Set<DiscoverNeedLabel>();
  const labelPriors = new Map<DiscoverNeedLabel, number>();
  const tokens = tokenizeForMatch(`${product.name} ${product.tags?.join(" ") ?? ""} ${metadataText(product)}`);
  const genericBundle = Boolean(modelProfile?.isGenericBundle ?? isGenericBundleProduct(product));

  if (modelProfile) {
    for (const role of modelProfile.roles) roles.add(role);
    for (const label of modelProfile.labels) labels.add(label);
    for (const [label, value] of Object.entries(modelProfile.labelPriors ?? {})) {
      labelPriors.set(label as DiscoverNeedLabel, Number(value) || 0);
    }
    applyNameRoles(product, roles);
    applyCompositeRoles(product, roles);
  } else if (genericBundle) {
    roles.add("basket");
    labels.add("weekly_basket");
  } else {
    applyCategoryRoles(product, roles);
    applyNameRoles(product, roles);
    applyCompositeRoles(product, roles);
    applyTrainingRoles(product, training, roles, labels);
    applyMetadataLabels(product, labels);
  }

  if (roles.has("fruit") || roles.has("vegetable") || roles.has("grain") || roles.has("protein")) {
    labels.add("balanced");
  }

  if (roles.has("meat") || roles.has("fish")) {
    labels.delete("vegetarian");
  }

  return {
    product,
    roles,
    labels,
    categoryNames: categoryNames(product),
    tokens,
    metadataText: metadataText(product),
    isFood: Boolean(modelProfile?.isFood ?? isFoodProduct(product)),
    isGenericBundle: genericBundle,
    hasOptions: Array.isArray(product.availableOptions) && product.availableOptions.length > 0,
    rankPrior: Number(modelProfile?.rankPrior ?? 0),
    labelPriors,
  };
}

export function profileCatalog(
  products: Product[],
  training: DiscoverTrainingArtifacts
): DiscoverProductProfile[] {
  return products
    .filter((product) => product?.id && product?.name)
    .map((product) => profileProduct(product, training));
}
