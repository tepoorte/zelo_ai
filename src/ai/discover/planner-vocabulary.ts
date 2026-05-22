import type {
  DiscoverNeedLabel,
  DiscoverPlannerVocabulary,
  DiscoverProductRole,
  DiscoverTrainingArtifacts,
} from "./types.js";
import {
  DISCOVER_NEED_LABELS,
  DISCOVER_PRODUCT_ROLES,
} from "./types.js";
import { normalizeText } from "../../domain/normalizer.js";

export type DiscoverPlannerChoices = {
  needs: DiscoverNeedLabel[];
  roles: DiscoverProductRole[];
};

const NEED_QUERY_ALIASES: Record<string, string[]> = {
  aperitif: ["apero", "aperitif", "amis", "partager"],
  balanced: ["equilibre", "equilibree", "complet", "leger", "frai"],
  breakfast: ["petit dejeuner", "dejeuner", "matin", "breakfast"],
  budget: ["budget", "cher", "economique", "economiser"],
  cleaning: ["menage", "nettoyage", "lessive", "nettoyant"],
  dessert: ["dessert", "gourmand", "douceur", "sucre"],
  dinner: ["soir", "diner", "souper", "repas"],
  discovery_open: ["propose", "idee", "idees", "suggestion", "quoi", "conseille"],
  drink: ["boir", "boire", "boisson", "jus", "accompagner"],
  gift: ["cadeau", "offrir"],
  healthy: ["sante", "sain", "saine", "manger mieux", "energie"],
  hygiene: ["hygiene", "savon", "shampoing", "dentifrice"],
  kids: ["enfant", "enfants", "petits", "gouter"],
  local: ["local", "coin", "gland", "region"],
  quick: ["rapide", "vite", "simple", "facile", "pas le temps"],
  vegetarian: ["vegetarien", "vegetarienne", "veggie", "sans viande"],
  weekly_basket: ["semaine", "courses", "panier"],
  zero_waste: ["zero dechet", "durable", "dechet"],
};

const ROLE_QUERY_ALIASES: Record<string, string[]> = {
  aperitif: ["apero", "aperitif", "olive", "chips", "noix"],
  bakery: ["boulangerie", "patisserie"],
  basket: ["panier", "offre", "surprise", "courses"],
  bread: ["pain", "baguette", "toast"],
  breakfast: ["petit dejeuner", "dejeuner", "matin", "muesli"],
  cheese: ["fromage", "gruyere", "mozzarella", "raclette", "crottin"],
  cleaning: ["menage", "lessive", "nettoyant"],
  condiment: ["condiment", "sel", "poivre", "epice"],
  dairy: ["lait", "yaourt", "yogourt", "yoghourt", "brebis"],
  dessert: ["dessert", "gateau", "sorbet", "glace", "chocolat"],
  drink: ["boir", "boire", "boisson", "jus", "sirop", "the", "cafe"],
  egg: ["oeuf", "oeufs"],
  fish: ["poisson", "perche", "perches", "brochet", "fera"],
  fruit: ["fruit", "fruits", "pomme", "pommes", "ananas", "banane", "fraise"],
  gift: ["cadeau", "offrir", "coffret"],
  grain: ["cereale", "cereales", "muesli", "farine"],
  hygiene: ["hygiene", "savon", "shampoing", "dentifrice"],
  meat: ["viande", "boeuf", "poulet", "porc", "dinde", "lard", "jambon", "saucisse", "salami"],
  menu: ["menu", "plat", "pizza"],
  oil: ["huile", "vinaigre"],
  pantry: ["epicerie", "placard", "reserve"],
  prepared_meal: ["plat", "pizza", "menu", "pannette", "pret"],
  protein: ["proteine", "proteines"],
  sauce: ["sauce", "ketchup", "moutarde", "mayonnaise"],
  snack: ["snack", "gouter", "chips", "noix"],
  starch: ["riz", "pates", "pate", "pomme de terre", "patate", "feculent"],
  sweet: ["sucre", "miel", "chocolat", "bonbon"],
  vegetable: ["legume", "legumes", "salade", "tomate", "carotte", "asperge", "chou"],
};

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function fallbackDiscoverPlannerVocabulary(): DiscoverPlannerVocabulary {
  return {
    needs: [...DISCOVER_NEED_LABELS],
    roles: [...DISCOVER_PRODUCT_ROLES],
  };
}

export function normalizeDiscoverPlannerVocabulary(
  value?: Partial<DiscoverPlannerVocabulary> | null
): DiscoverPlannerVocabulary {
  const fallback = fallbackDiscoverPlannerVocabulary();
  const needs = uniqueStrings(value?.needs);
  const roles = uniqueStrings(value?.roles);

  return {
    needs: (needs.length ? needs : fallback.needs) as DiscoverNeedLabel[],
    roles: (roles.length ? roles : fallback.roles) as DiscoverProductRole[],
  };
}

export function discoverPlannerVocabularyFromTraining(
  training: DiscoverTrainingArtifacts
): DiscoverPlannerVocabulary {
  return normalizeDiscoverPlannerVocabulary(training.model?.plannerVocabulary);
}

export function normalizeDiscoverPlannerChoices(
  value: unknown,
  vocabulary: DiscoverPlannerVocabulary
): DiscoverPlannerChoices {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const allowedNeeds = new Set(vocabulary.needs.map(String));
  const allowedRoles = new Set(vocabulary.roles.map(String));

  return {
    needs: uniqueStrings(payload.needs)
      .filter((label) => allowedNeeds.has(label))
      .slice(0, 5) as DiscoverNeedLabel[],
    roles: uniqueStrings(payload.roles)
      .filter((role) => allowedRoles.has(role))
      .slice(0, 5) as DiscoverProductRole[],
  };
}

function hasQueryEvidence(query: string, label: string, aliases: Record<string, string[]>): boolean {
  const normalizedQuery = normalizeText(query);
  const terms = aliases[label] ?? [label];
  return terms.some((term) => normalizedQuery.includes(normalizeText(term)));
}

function inferLabelsFromQuery<T extends string>(
  query: string,
  allowed: T[],
  aliases: Record<string, string[]>
): T[] {
  return allowed.filter((label) => hasQueryEvidence(query, label, aliases));
}

export function filterDiscoverPlannerChoicesByQuery(
  query: string,
  choices: DiscoverPlannerChoices
): DiscoverPlannerChoices {
  return {
    needs: choices.needs.filter((label) => hasQueryEvidence(query, label, NEED_QUERY_ALIASES)),
    roles: choices.roles.filter((role) => hasQueryEvidence(query, role, ROLE_QUERY_ALIASES)),
  };
}

export function enrichDiscoverPlannerChoicesFromQuery(
  query: string,
  choices: DiscoverPlannerChoices,
  vocabulary: DiscoverPlannerVocabulary
): DiscoverPlannerChoices {
  return {
    needs: [
      ...new Set([
        ...choices.needs,
        ...inferLabelsFromQuery(query, vocabulary.needs, NEED_QUERY_ALIASES),
      ]),
    ].slice(0, 5) as DiscoverNeedLabel[],
    roles: [
      ...new Set([
        ...choices.roles,
        ...inferLabelsFromQuery(query, vocabulary.roles, ROLE_QUERY_ALIASES),
      ]),
    ].slice(0, 5) as DiscoverProductRole[],
  };
}

export function discoverPlannerPrompt(vocabulary: DiscoverPlannerVocabulary): string {
  return `
Choisis uniquement les labels utiles pour DISCOVER_MEALS.
needs possibles: ${vocabulary.needs.join(", ")}
roles possibles: ${vocabulary.roles.join(", ")}
Réponds seulement avec ce JSON: {"needs":[],"roles":[]}
Ne choisis jamais de produits.
`.trim();
}

export function discoverPlannerJsonSchema(vocabulary: DiscoverPlannerVocabulary): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      needs: {
        type: "array",
        items: { type: "string", enum: vocabulary.needs },
        maxItems: 5,
      },
      roles: {
        type: "array",
        items: { type: "string", enum: vocabulary.roles },
        maxItems: 5,
      },
    },
    required: ["needs", "roles"],
    additionalProperties: false,
  };
}
