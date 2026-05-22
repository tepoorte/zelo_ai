import { buildDiscoverMealIdeas } from "../discover/engine.js";
import type {
  DiscoverNeedLabel,
  DiscoverProductRole,
} from "../discover/types.js";

export async function handleDiscoverMealIdeasAction(
  userRef: string,
  query = "",
  hints?: {
    needHints?: DiscoverNeedLabel[];
    roleHints?: DiscoverProductRole[];
    focusTerms?: string[];
    constraints?: string[];
  }
) {
  return await buildDiscoverMealIdeas(userRef, query, { hints });
}
