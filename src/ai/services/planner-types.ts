import type {
  DiscoverNeedLabel,
  DiscoverProductRole,
} from "../discover/types.js";

export type PlannedAction =
  | { type: "search_products"; query: string; limit?: number }
  | {
      type: "add_to_cart";
      userRef?: string;
      items: Array<{
        query: string;
        qty: number;
        unit?: string;
        productId?: string;
      }>;
    }
  | { type: "get_cart"; userRef?: string }
  | {
      type: "clear_cart";
      userRef?: string;
      mode?: "all" | "partial";
      items?: Array<{
        query: string;
      }>;
    }
  | { type: "exec_cart"; userRef?: string }
  | {
      type: "discover_meal_ideas";
      userRef?: string;
      query?: string;
      needHints?: DiscoverNeedLabel[];
      roleHints?: DiscoverProductRole[];
      focusTerms?: string[];
      constraints?: string[];
    }
  | { type: "noop"; reason?: string };

export type Plan = {
  intent: string;
  actions: PlannedAction[];
  userFacingDraft?: string;
};

export type FrontendIntentHint = {
  actionKey?:
    | "add_items"
    | "clear_cart"
    | "show_cart"
    | "exec_cart"
    | "build_meal"
    | "discover_meals"
    | "noop";
  confidence?: number;
  family?: string;
  planner?: string;
};
