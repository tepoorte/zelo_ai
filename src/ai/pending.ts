export type PendingOptionChoice = {
  type: "awaiting_options";
  productId: string;
  productName: string;
  qty: number;
  unit?: string;
  remainingItems?: Array<{
    query: string;
    qty: number;
    unit?: string;
    productId?: string;
  }>;
  availableOptions: Array<{
    id: string;
    name: string;
    shortDescription?: string;
    description?: string;
  }>;
};

export type PendingMealCategoryChoice = {
  type: "awaiting_food_category";
  categories: Array<{
    id: string;
    name: string;
  }>;
};

export type PendingMealSuggestionChoice = {
  type: "awaiting_category_suggestion";
  categoryId: string;
  categoryName: string;
  suggestions: Array<{
    productId: string;
    name: string;
  }>;
};

export type PendingState =
  | PendingOptionChoice
  | PendingMealCategoryChoice
  | PendingMealSuggestionChoice;

const pending = new Map<string, PendingState>();

export function setPending(userRef: string, value: PendingState) {
  pending.set(userRef, value);
}

export function getPending(userRef: string): PendingState | undefined {
  return pending.get(userRef);
}

export function clearPending(userRef: string) {
  pending.delete(userRef);
}
