import type {
  DiscoverProductRole,
  DiscoverProposal,
  DiscoverSemanticFrame,
  DiscoverSemanticRoleIntent,
} from "./types.js";

function proposalRoles(proposal: DiscoverProposal): Set<DiscoverProductRole> {
  return new Set(proposal.products.flatMap((product) => product.roles));
}

function hasAnyRole(roles: Set<DiscoverProductRole>, targets: Iterable<DiscoverProductRole>): boolean {
  for (const role of targets) {
    if (roles.has(role)) return true;
    if (role === "protein" && ["meat", "fish", "egg", "cheese"].some((candidate) => roles.has(candidate as DiscoverProductRole))) {
      return true;
    }
    if (role === "starch" && roles.has("grain")) return true;
    if (role === "bread" && roles.has("bakery")) return true;
    if (role === "cleaning" && roles.has("hygiene")) return true;
    if (role === "dessert" && ["sweet", "fruit", "dairy", "bakery"].some((candidate) => roles.has(candidate as DiscoverProductRole))) {
      return true;
    }
  }
  return false;
}

function hasForbiddenRole(roles: Set<DiscoverProductRole>, role: DiscoverProductRole): boolean {
  if (roles.has(role)) return true;
  if (role === "protein") return ["meat", "fish", "egg", "cheese"].some((candidate) => roles.has(candidate as DiscoverProductRole));
  if (role === "starch") return roles.has("grain");
  if (role === "bread") return roles.has("bakery");
  return false;
}

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
  vegetable: ["fruit", "meat", "fish", "egg", "cheese", "bread", "grain", "drink", "cleaning", "hygiene"],
  dessert: ["meat", "fish", "cleaning", "hygiene"],
};

function semanticIntents(frame: DiscoverSemanticFrame, polarities: DiscoverSemanticRoleIntent["polarity"][]): DiscoverSemanticRoleIntent[] {
  return frame.roleIntents.filter((intent) => polarities.includes(intent.polarity));
}

function isMixedProduceStrictRole(role: DiscoverProductRole): boolean {
  return role === "fruit" || role === "vegetable";
}

function strictDomainViolation(frame: DiscoverSemanticFrame, proposal: DiscoverProposal): string | null {
  const domain = frame.domains[0];
  if (!domain || domain.score < 0.78) return null;

  if (domain.name === "drink" && proposal.products.some((product) => !product.roles.includes("drink"))) return "domain:drink";
  if (
    domain.name === "cleaning" &&
    proposal.products.some((product) => !hasAnyRole(new Set(product.roles), ["cleaning", "hygiene"]))
  ) return "domain:cleaning";
  if (domain.name === "hygiene" && proposal.products.some((product) => !product.roles.includes("hygiene"))) return "domain:hygiene";
  return null;
}

export function scoreSemanticProposal(
  proposal: DiscoverProposal,
  frame: DiscoverSemanticFrame
): DiscoverProposal {
  const roles = proposalRoles(proposal);
  const coverage: string[] = [];
  const violations: string[] = [];
  let semanticScore = 0;
  const requestedAnimalRoles = frame.roleIntents
    .filter((intent) =>
      ["prefer", "strict"].includes(intent.polarity) &&
      ["fish", "meat"].includes(String(intent.role)) &&
      intent.score >= 0.5
    )
    .map((intent) => intent.role);
  let adjustedNeeds = proposal.needs;
  const explicitlyAnimal = requestedAnimalRoles.length > 0;
  const proposalHasRequestedAnimal = hasAnyRole(roles, requestedAnimalRoles);

  if (explicitlyAnimal && proposal.needs.includes("vegetarian")) {
    if (proposalHasRequestedAnimal) {
      adjustedNeeds = proposal.needs.filter((need) => need !== "vegetarian");
    } else {
      violations.push("semantic_conflict:vegetarian");
      semanticScore -= 120;
    }
  }
  const explicitAnimalWithoutMatch = frame.roleIntents.some((intent) =>
    ["prefer", "strict"].includes(intent.polarity) &&
    ["fish", "meat"].includes(String(intent.role)) &&
    intent.score >= 0.5
  ) && !proposalHasRequestedAnimal;
  if (explicitAnimalWithoutMatch) semanticScore -= 18;

  for (const intent of semanticIntents(frame, ["prefer", "strict", "complement"])) {
    const strictIntents = semanticIntents(frame, ["strict"]);
    const mixedProduceStrict = strictIntents.length >= 2 && strictIntents.every((item) => isMixedProduceStrictRole(item.role));

    if (intent.polarity === "strict" && mixedProduceStrict && isMixedProduceStrictRole(intent.role)) {
      const strictRoles = strictIntents.map((item) => item.role);
      const everyProductInRequestedDomains = proposal.products.every((product) => hasAnyRole(new Set(product.roles), strictRoles));
      const roleCovered = hasAnyRole(roles, [intent.role]);
      if (!everyProductInRequestedDomains) {
        violations.push("strict_domain:produce_mix");
        semanticScore -= 90 * intent.score;
      } else if (roleCovered) {
        coverage.push(`strict:${intent.role}`);
        semanticScore += 16 * intent.score;
      } else {
        violations.push(`missing:${intent.role}`);
        semanticScore -= 80 * intent.score;
      }
      continue;
    }

    if (intent.polarity === "strict" && proposal.products.some((product) => {
      const productRoles = new Set(product.roles);
      return !hasAnyRole(productRoles, [intent.role]) || hasAnyRole(productRoles, STRICT_ROLE_BLOCKERS[intent.role] ?? []);
    })) {
      violations.push(`strict_domain:${intent.role}`);
      semanticScore -= 90 * intent.score;
      continue;
    }

    if (hasAnyRole(roles, [intent.role])) {
      coverage.push(`${intent.polarity}:${intent.role}`);
      semanticScore += (intent.polarity === "strict" ? 16 : 9) * intent.score;
    } else if (intent.polarity === "strict") {
      violations.push(`missing:${intent.role}`);
      semanticScore -= 80 * intent.score;
    }
  }

  for (const intent of semanticIntents(frame, ["avoid", "limit"])) {
    if (!hasForbiddenRole(roles, intent.role)) continue;
    violations.push(`${intent.polarity}:${intent.role}`);
    semanticScore -= (intent.polarity === "avoid" ? 80 : 18) * intent.score;
  }

  for (const concept of frame.concepts) {
    if (concept.score < 0.45) continue;
    const conceptRoles = {
      healthy: ["fruit", "vegetable", "grain", "starch"],
      light: ["fruit", "vegetable", "starch", "grain"],
      nutrition_support: ["fruit", "vegetable"],
      picnic: ["bread", "cheese", "fruit", "drink", "snack"],
      aperitif: ["aperitif", "cheese", "bread", "drink", "snack"],
      hosting: ["aperitif", "cheese", "bread", "drink"],
      sharing: ["aperitif", "cheese", "bread", "drink"],
      breakfast: ["breakfast", "grain", "dairy", "fruit", "bread"],
      kids: ["fruit", "dairy", "grain", "bread"],
    }[concept.name] as DiscoverProductRole[] | undefined;
    if (conceptRoles && hasAnyRole(roles, conceptRoles)) {
      coverage.push(`concept:${concept.name}`);
      semanticScore += 6 * concept.score;
    }
    const conceptForbiddenRoles = {
      healthy: ["meat", "prepared_meal", "menu", "sweet"],
      nutrition_support: ["bakery", "dessert", "sweet", "pantry", "condiment", "prepared_meal", "menu", "cleaning", "hygiene"],
      picnic: ["breakfast", "prepared_meal", "menu", "oil", "sauce", "cleaning", "hygiene"],
      aperitif: ["breakfast", "prepared_meal", "menu", "cleaning", "hygiene"],
      hosting: ["breakfast", "cleaning", "hygiene"],
      sharing: ["breakfast", "cleaning", "hygiene"],
    }[concept.name] as DiscoverProductRole[] | undefined;
    if (conceptForbiddenRoles && hasAnyRole(roles, conceptForbiddenRoles)) {
      violations.push(`concept_drift:${concept.name}`);
      semanticScore -= 14 * concept.score;
    }
  }

  const domainViolation = strictDomainViolation(frame, proposal);
  if (domainViolation) {
    violations.push(domainViolation);
    semanticScore -= 90;
  }

  const roleDiversity = Math.min(4, roles.size) * 1.2;
  semanticScore += roleDiversity;

  return {
    ...proposal,
    needs: adjustedNeeds,
    score: proposal.score + semanticScore,
    semanticScore,
    semanticCoverage: [...new Set([...(proposal.semanticCoverage ?? []), ...coverage])].slice(0, 10),
    semanticViolations: [...new Set([...(proposal.semanticViolations ?? []), ...violations])].slice(0, 10),
  };
}

export function rankSemanticProposals(
  proposals: DiscoverProposal[],
  frame: DiscoverSemanticFrame
): DiscoverProposal[] {
  return proposals
    .map((proposal) => scoreSemanticProposal(proposal, frame))
    .filter((proposal) => !(proposal.semanticViolations ?? []).some((violation) =>
      violation.startsWith("domain:") ||
      violation.startsWith("strict_domain:") ||
      violation.startsWith("avoid:") ||
      violation.startsWith("semantic_conflict:")
    ))
    .sort((left, right) => right.score - left.score);
}
