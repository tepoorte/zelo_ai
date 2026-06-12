import { tokenizeForMatch } from "../../domain/normalizer.js";
import { textSimilarity } from "../../domain/text-similarity.js";
import type {
  DiscoverNeedLabel,
  DiscoverNeedScore,
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverProposal,
  DiscoverProposalProduct,
  DiscoverSemanticFrame,
} from "./types.js";

type SemanticProductEntry = {
  profile: DiscoverProductProfile;
  score: number;
};

type GraphRecipe = {
  id: string;
  title: string;
  roles: DiscoverProductRole[];
  why: string;
  strict?: boolean;
  roleAvoidRoles?: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>>;
};

const ROLE_COMPLEMENTS: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>> = {
  fish: ["fish", "starch", "vegetable", "oil", "sauce", "bread"],
  meat: ["meat", "starch", "vegetable", "oil", "sauce", "bread"],
  egg: ["egg", "bread", "vegetable", "starch", "cheese"],
  cheese: ["cheese", "bread", "vegetable", "drink"],
  protein: ["protein", "starch", "vegetable", "oil"],
  prepared_meal: ["prepared_meal", "vegetable", "drink"],
  breakfast: ["grain", "dairy", "fruit", "bread", "drink"],
};

const ROLE_FAMILIES: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>> = {
  protein: ["protein", "meat", "fish", "egg", "cheese"],
  starch: ["starch", "grain"],
  bread: ["bread", "bakery"],
  cheese: ["cheese", "dairy"],
  dairy: ["dairy"],
  dessert: ["dessert", "sweet", "fruit", "dairy", "bakery"],
};

const STRICT_ROLE_BLOCKERS: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>> = {
  fruit: [
    "starch",
    "vegetable",
    "meat",
    "fish",
    "egg",
    "cheese",
    "dairy",
    "bread",
    "bakery",
    "grain",
    "drink",
    "oil",
    "sauce",
    "prepared_meal",
    "menu",
    "sweet",
    "cleaning",
    "hygiene",
  ],
  vegetable: ["fruit", "meat", "fish", "egg", "cheese", "bread", "grain", "drink", "oil", "sauce", "condiment", "pantry", "cleaning", "hygiene"],
  dessert: ["meat", "fish", "cleaning", "hygiene"],
};

function activeLabels(needs: DiscoverNeedScore[]): DiscoverNeedLabel[] {
  const labels = needs.filter((need) => need.score >= 0.25).map((need) => need.label);
  return labels.length ? labels : needs.map((need) => need.label);
}

function hasRole(profile: DiscoverProductProfile, role: DiscoverProductRole): boolean {
  if (profile.roles.has(role)) return true;
  return (ROLE_FAMILIES[role] ?? []).some((related) => profile.roles.has(related));
}

function hasAnyRole(profile: DiscoverProductProfile, roles: Iterable<DiscoverProductRole>): boolean {
  for (const role of roles) {
    if (hasRole(profile, role)) return true;
  }
  return false;
}

function hasExactAnyRole(profile: DiscoverProductProfile, roles: Iterable<DiscoverProductRole>): boolean {
  for (const role of roles) {
    if (profile.roles.has(role)) return true;
  }
  return false;
}

function singular(value: string): string {
  return value.endsWith("s") && value.length > 4 ? value.slice(0, -1) : value;
}

function directNameMatchScore(query: string, profile: DiscoverProductProfile): number {
  const queryTokens = new Set(tokenizeForMatch(query).map(singular).filter((token) => token.length >= 4));
  const nameTokens = new Set(tokenizeForMatch(profile.product.name).map(singular).filter((token) => token.length >= 4));
  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 1;
  }
  return score;
}

function proposalProduct(profile: DiscoverProductProfile): DiscoverProposalProduct {
  const primaryRole = [...profile.roles][0];
  return {
    productId: String(profile.product.id),
    name: profile.product.name,
    roles: [...profile.roles].slice(0, 5),
    reason: primaryRole ? `rôle catalogue : ${primaryRole}` : "produit du catalogue",
    hasOptions: profile.hasOptions,
  };
}

function productAlreadyUsed(profile: DiscoverProductProfile, products: DiscoverProposalProduct[]): boolean {
  return products.some((product) =>
    product.productId === String(profile.product.id) ||
    textSimilarity(product.name, profile.product.name) >= 0.74
  );
}

function chooseByRole(
  entries: SemanticProductEntry[],
  role: DiscoverProductRole,
  products: DiscoverProposalProduct[],
  usedProductIds: Set<string>,
  avoidRoles: Set<DiscoverProductRole>,
  query: string,
  roleAvoidRoles: Iterable<DiscoverProductRole> = []
): DiscoverProposalProduct | null {
  const contextualAvoidRoles = new Set(roleAvoidRoles);
  const found = entries
    .filter((entry) => {
      if (entry.score <= -75) return false;
      if (usedProductIds.has(String(entry.profile.product.id))) return false;
      if (productAlreadyUsed(entry.profile, products)) return false;
      if (hasExactAnyRole(entry.profile, avoidRoles)) return false;
      if (hasExactAnyRole(entry.profile, contextualAvoidRoles)) return false;
      if (hasExactAnyRole(entry.profile, STRICT_ROLE_BLOCKERS[role] ?? [])) return false;
      return hasRole(entry.profile, role);
    })
    .sort((left, right) =>
      directNameMatchScore(query, right.profile) - directNameMatchScore(query, left.profile) ||
      right.score - left.score
    )[0];

  return found ? proposalProduct(found.profile) : null;
}

function conceptNames(frame: DiscoverSemanticFrame): Set<string> {
  return new Set(frame.concepts.filter((concept) => concept.score >= 0.45).map((concept) => concept.name));
}

function preferredRoles(frame: DiscoverSemanticFrame): DiscoverProductRole[] {
  const roles = frame.roleIntents
    .filter((intent) => ["prefer", "strict"].includes(intent.polarity) && intent.score >= 0.42)
    .sort((left, right) => right.score - left.score)
    .map((intent) => intent.role);
  return [...new Set(roles)].slice(0, 8);
}

function avoidedRoles(frame: DiscoverSemanticFrame): Set<DiscoverProductRole> {
  return new Set(
    frame.roleIntents
      .filter((intent) => ["avoid", "limit"].includes(intent.polarity) && intent.score >= 0.55)
      .map((intent) => intent.role)
  );
}

function strictDomainRecipe(frame: DiscoverSemanticFrame): GraphRecipe | null {
  const domain = frame.domains[0];
  if (!domain || domain.score < 0.78) return null;

  if (domain.name === "drink") {
    return {
      id: "semantic_drink",
      title: "Boisson pour accompagner",
      roles: ["drink"],
      why: "sélection limitée au domaine boisson demandé",
      strict: true,
      roleAvoidRoles: {
        drink: ["alcohol", "dairy"],
      },
    };
  }
  if (domain.name === "cleaning") {
    return {
      id: "semantic_cleaning",
      title: "Produits pour la maison",
      roles: ["cleaning", "hygiene"],
      why: "sélection limitée aux produits de maison du catalogue",
      strict: true,
    };
  }
  if (domain.name === "hygiene") {
    return {
      id: "semantic_hygiene",
      title: "Produits d’hygiène",
      roles: ["hygiene"],
      why: "sélection limitée aux produits d’hygiène du catalogue",
      strict: true,
    };
  }
  return null;
}

function violatesStrictBlockersForRecipe(
  profile: DiscoverProductProfile,
  roles: DiscoverProductRole[]
): boolean {
  const matchingRoles = roles.filter((role) => hasRole(profile, role));
  if (!matchingRoles.length) return false;
  const mixedProduce = roles.includes("fruit") && roles.includes("vegetable");
  return matchingRoles.every((role) => {
    const blockers = (STRICT_ROLE_BLOCKERS[role] ?? []).filter((blocker) =>
      !(mixedProduce && (blocker === "fruit" || blocker === "vegetable"))
    );
    return hasExactAnyRole(profile, blockers);
  });
}

function graphRecipes(frame: DiscoverSemanticFrame): GraphRecipe[] {
  const concepts = conceptNames(frame);
  const roles = preferredRoles(frame);
  const recipes: GraphRecipe[] = [];
  const strict = strictDomainRecipe(frame);
  if (strict) recipes.push(strict);
  const strictRoles = new Set(
    frame.roleIntents
      .filter((item) => item.polarity === "strict" && item.score >= 0.55)
      .map((item) => item.role)
  );

  if (strictRoles.has("fruit") && strictRoles.has("vegetable")) {
    recipes.push({
      id: "semantic_strict_fruit_vegetable",
      title: "Sélection de fruits et légumes",
      roles: ["fruit", "vegetable"],
      why: "sélection limitée aux fruits et légumes demandés",
      strict: true,
    });
  }

  for (const intent of frame.roleIntents.filter((item) => item.polarity === "strict" && item.score >= 0.55)) {
    if (!["fruit", "vegetable", "dessert"].includes(String(intent.role))) continue;
    if (strictRoles.has("fruit") && strictRoles.has("vegetable") && ["fruit", "vegetable"].includes(String(intent.role))) {
      continue;
    }
    recipes.push({
      id: `semantic_strict_${intent.role}`,
      title: intent.role === "fruit" ? "Sélection de fruits" : intent.role === "vegetable" ? "Sélection de légumes" : "Idée dessert",
      roles: [intent.role],
      why: `sélection limitée au domaine ${String(intent.role).replace(/_/g, " ")} demandé`,
      strict: true,
    });
  }

  if (concepts.has("picnic")) {
    recipes.push({
      id: "semantic_picnic",
      title: "Idée pique-nique",
      roles: ["bread", "cheese", "fruit", "drink"],
      why: "composition facile à transporter et à manger sans préparation lourde",
      roleAvoidRoles: {
        bread: ["dessert", "sweet"],
        fruit: ["bakery", "dessert", "sweet", "dairy", "meat", "fish", "egg", "protein"],
        drink: ["dairy"],
      },
    });
  }

  if (concepts.has("aperitif")) {
    recipes.push({
      id: "semantic_aperitif",
      title: "Apéro à partager",
      roles: ["drink", "cheese", "bread", "aperitif"],
      why: "composition adaptée à un apéro avec produits faciles à partager",
      roleAvoidRoles: {
        drink: ["dairy"],
        bread: ["dessert", "sweet"],
      },
    });
  }

  if ((concepts.has("hosting") || concepts.has("sharing")) && !concepts.has("picnic") && !concepts.has("aperitif")) {
    recipes.push({
      id: "semantic_hosting",
      title: "Idée à partager",
      roles: ["cheese", "bread", "drink", "aperitif", "snack"],
      why: "composition orientée partage et accueil",
      roleAvoidRoles: {
        drink: ["dairy"],
        bread: ["dessert", "sweet"],
      },
    });
  }

  if (concepts.has("breakfast")) {
    recipes.push({
      id: "semantic_breakfast",
      title: "Idée petit-déjeuner",
      roles: ["grain", "dairy", "fruit", "bread", "drink"],
      why: "composition adaptée au matin",
    });
  }

  if (concepts.has("kids")) {
    recipes.push({
      id: "semantic_kids",
      title: "Idée goûter simple",
      roles: ["fruit", "dairy", "grain", "bread"],
      why: "composition simple adaptée aux enfants ou au goûter",
    });
  }

  if (concepts.has("nutrition_support")) {
    recipes.push({
      id: "semantic_nutrition_fruit",
      title: "Fruits frais",
      roles: ["fruit"],
      why: "sélection générale orientée fruits, sans promesse médicale",
      strict: true,
    });
    recipes.push({
      id: "semantic_nutrition_vegetable",
      title: "Légumes simples",
      roles: ["vegetable"],
      why: "sélection générale orientée légumes, sans promesse médicale",
      strict: true,
    });
  } else if (concepts.has("healthy") && !concepts.has("aperitif") && !concepts.has("picnic")) {
    recipes.push({
      id: "semantic_healthy",
      title: "Idée saine",
      roles: ["vegetable", "fruit", "grain", "starch"],
      why: "composition générale orientée produits simples, fruits et légumes",
    });
  }

  if (concepts.has("light")) {
    recipes.push({
      id: "semantic_light",
      title: "Idée légère",
      roles: ["vegetable", "fruit", "starch", "grain"],
      why: "composition légère avec protéines limitées",
    });
  }

  const hasSpecificConcept = ["picnic", "aperitif", "nutrition_support"].some((concept) => concepts.has(concept));
  if (!hasSpecificConcept) {
    for (const role of roles) {
      const complementRoles = ROLE_COMPLEMENTS[role];
      if (!complementRoles?.length) continue;
      recipes.push({
        id: `semantic_${role}`,
        title: `Idée avec ${String(role).replace(/_/g, " ")}`,
        roles: complementRoles,
        why: "composition construite autour du rôle principal demandé",
      });
    }
  }

  if (!recipes.length && roles.length) {
    recipes.push({
      id: "semantic_adapted",
      title: "Idée adaptée",
      roles,
      why: "sélection adaptée aux signaux principaux de la demande",
    });
  }

  return recipes;
}

function buildProposalFromRecipe(input: {
  recipe: GraphRecipe;
  entries: SemanticProductEntry[];
  needs: DiscoverNeedScore[];
  frame: DiscoverSemanticFrame;
  usedProductIds: Set<string>;
  maxProducts: number;
  index: number;
}): DiscoverProposal | null {
  const products: DiscoverProposalProduct[] = [];
  const avoidRoles = avoidedRoles(input.frame);

  for (const role of input.recipe.roles) {
    const product = chooseByRole(
      input.entries,
      role,
      products,
      input.usedProductIds,
      avoidRoles,
      input.frame.cleanedQuery,
      input.recipe.roleAvoidRoles?.[role] ?? []
    );
    if (!product) continue;
    products.push(product);
    if (products.length >= input.maxProducts) break;
  }

  if (input.recipe.strict) {
    const strictRecipeAvoidRoles = new Set(
      input.recipe.roles.flatMap((role) => input.recipe.roleAvoidRoles?.[role] ?? [])
    );
    const strictEntries = [...input.entries].sort((left, right) =>
      directNameMatchScore(input.frame.cleanedQuery, right.profile) - directNameMatchScore(input.frame.cleanedQuery, left.profile) ||
      right.score - left.score
    );
    for (const entry of strictEntries) {
      if (products.length >= input.maxProducts) break;
      if (input.usedProductIds.has(String(entry.profile.product.id))) continue;
      if (productAlreadyUsed(entry.profile, products)) continue;
      if (hasExactAnyRole(entry.profile, avoidRoles)) continue;
      if (hasExactAnyRole(entry.profile, strictRecipeAvoidRoles)) continue;
      if (violatesStrictBlockersForRecipe(entry.profile, input.recipe.roles)) continue;
      if (!hasAnyRole(entry.profile, input.recipe.roles)) continue;
      products.push(proposalProduct(entry.profile));
    }
  }

  const minProducts = input.recipe.strict ? 1 : Math.min(2, input.maxProducts);
  if (products.length < minProducts) return null;

  const productScore = products.reduce((sum, product) => {
    const entry = input.entries.find((candidate) => String(candidate.profile.product.id) === product.productId);
    return sum + Math.max(0, entry?.score ?? 0);
  }, 0);

  return {
    id: `${input.recipe.id}_${input.index}`,
    title: input.recipe.title,
    why: input.recipe.why,
    score: productScore + 45 - input.index,
    needs: activeLabels(input.needs),
    products,
    semanticCoverage: input.recipe.roles.map(String),
  };
}

export function buildSemanticGraphProposals(input: {
  frame: DiscoverSemanticFrame;
  scoredProducts: SemanticProductEntry[];
  needs: DiscoverNeedScore[];
  maxProducts: number;
  maxProposals: number;
  usedProductIds?: Set<string>;
}): DiscoverProposal[] {
  if (input.frame.confidence < 0.28) return [];

  const recipes = graphRecipes(input.frame);
  const usedProductIds = new Set(input.usedProductIds ?? []);
  const proposals: DiscoverProposal[] = [];
  const targetCount = Math.min(
    input.maxProposals,
    Math.max(1, input.frame.requestCount ?? (input.frame.concepts.some((concept) => concept.name === "discovery_open") ? 3 : 2))
  );

  for (const recipe of recipes) {
    const proposal = buildProposalFromRecipe({
      recipe,
      entries: input.scoredProducts,
      needs: input.needs,
      frame: input.frame,
      usedProductIds,
      maxProducts: input.maxProducts,
      index: proposals.length + 1,
    });
    if (!proposal) continue;
    proposals.push(proposal);
    for (const product of proposal.products) usedProductIds.add(product.productId);
    if (proposals.length >= targetCount) break;
  }

  return proposals;
}
