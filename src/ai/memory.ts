type ConversationState = {
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

const store = new Map<string, ConversationState>();

export function getMemory(userRef: string): ConversationState {
  if (!store.has(userRef)) {
    store.set(userRef, { history: [] });
  }
  return store.get(userRef)!;
}

export function addToMemory(userRef: string, role: "user" | "assistant", content: string) {
  const mem = getMemory(userRef);
  mem.history.push({ role, content });

  // Mantieni solo ultimi 10 messaggi
  if (mem.history.length > 10) {
    mem.history = mem.history.slice(-10);
  }
}

export function clearMemory(userRef: string) {
  store.delete(userRef);
}