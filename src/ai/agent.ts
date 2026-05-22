import { runAgentOllama } from "./agent.ollama.js";
import type { FrontendIntentHint } from "./services/planner-types.js";

export async function runAgent(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<Record<string, any> & { message: string }> {
  return runAgentOllama(userRef, userText, intentHint);
}
