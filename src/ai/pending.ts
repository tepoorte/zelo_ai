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

export type PendingRecurringOrderSummary = {
  id: string;
  name: string;
  dayLabels: string[];
  deliveryTime?: string | null;
  frequencyUnit?: string | null;
  frequencyLabel?: string | null;
  recurringOrderStatus?: string | null;
  start?: string | null;
  end?: string | null;
  nextDates: string[];
  products: Array<{
    productId: string;
    name: string;
    quantity: number;
  }>;
};

export type PendingRecurringOrderChoice = {
  type: "awaiting_recurring_order_choice";
  originalText: string;
  recurringOrders: PendingRecurringOrderSummary[];
};

export type PendingRecurringOrderChange = {
  type: "awaiting_recurring_order_change";
  recurringOrder: PendingRecurringOrderSummary;
};

export type PendingRecurringOrderConfirmation = {
  type: "awaiting_recurring_order_confirmation";
  recurringOrder: PendingRecurringOrderSummary;
  beforeProducts: PendingRecurringOrderSummary["products"];
  afterProducts: PendingRecurringOrderSummary["products"];
  changes: string[];
};

export type PendingState =
  | PendingOptionChoice
  | PendingMealCategoryChoice
  | PendingMealSuggestionChoice
  | PendingRecurringOrderChoice
  | PendingRecurringOrderChange
  | PendingRecurringOrderConfirmation;

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
