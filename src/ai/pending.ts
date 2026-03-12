export type PendingOptionChoice = {
  type: "awaiting_options";
  productId: string;
  productName: string;
  qty: number;
  unit?: string;
  availableOptions: Array<{
    id: string;
    name: string;
    shortDescription?: string;
    description?: string;
  }>;
};

const pending = new Map<string, PendingOptionChoice>();

export function setPending(userRef: string, value: PendingOptionChoice) {
  pending.set(userRef, value);
}

export function getPending(userRef: string): PendingOptionChoice | undefined {
  return pending.get(userRef);
}

export function clearPending(userRef: string) {
  pending.delete(userRef);
}