import { getMemory, addToMemory } from "../memory.js";
import { ollamaChat } from "./ollama-client.js";

function generalChatPrompt() {
  return `
You are Zelo AI, a friendly shopping and food assistant.

Rules:
- Reply naturally and helpfully.
- If the user asks normal questions, answer normally.
- If the question is about food, recipes, shopping, or products, stay practical.
- Always reply in French.
- Keep answers concise but useful.
`;
}


export async function runGeneralChat(userRef: string, userText: string): Promise<{ message: string }> {
  const mem = getMemory(userRef);

  const messages = [
    { role: "system", content: generalChatPrompt() },
    ...mem.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const reply = await ollamaChat(messages, 0.5);

  addToMemory(userRef, "user", userText);
  addToMemory(userRef, "assistant", reply || "Je ne sais pas quoi répondre pour le moment.");

  return {
    message: reply || "Je ne sais pas quoi répondre pour le moment.",
  };
}