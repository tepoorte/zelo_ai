// src/ai/agent.ts
/*import OpenAI from "openai";
import { env } from "../config/env.js";
import { tools } from "./schema.js";
import { systemPrompt } from "./prompts.js";

import { searchProducts } from "../swissdata/products.js";
import { addToCart, getCart } from "../swissdata/cart.js";

const client = new OpenAI({ apiKey: env.openaiApiKey });

type FunctionCallItem = OpenAI.Responses.ResponseFunctionToolCall;

// ✅ type guard per i tool calls (Responses API)
function isFunctionCallItem(x: OpenAI.Responses.ResponseOutputItem): x is FunctionCallItem {
  return (
    x.type === "function_call" &&
    typeof (x as any).call_id === "string" &&
    typeof (x as any).name === "string" &&
    typeof (x as any).arguments === "string"
  );
}

export async function runAgent(
  userRef: string,
  userText: string
): Promise<{ message: string }> {
  // "input" nella Responses API può contenere messaggi + tool outputs
  const input: any[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
  ];

  for (let step = 0; step < 8; step++) {
    const resp = await client.responses.create({
      model: "gpt-5-mini",
      input,
      tools: tools as any, // IMPORTANT: tools con name top-level
    });

    // ✅ Se il modello ha già risposto in testo
    if (resp.output_text && resp.output_text.trim()) {
      return { message: resp.output_text.trim() };
    }

    const calls = (resp.output ?? []).filter(isFunctionCallItem);

    if (calls.length === 0) {
      return {
        message:
          "Ok. Dimmi cosa vuoi fare (es. “voglio una caesar per 2 persone”).",
      };
    }

    // Esegui tool calls e rimanda i risultati al modello
    for (const fc of calls) {
      const args = fc.arguments ? JSON.parse(fc.arguments) : {};
      let result: any;

      if (fc.name === "search_products") {
        result = await searchProducts(args.query);
      } else if (fc.name === "add_to_cart") {
        result = await addToCart(args);
      } else if (fc.name === "get_cart") {
        result = await getCart(args.userRef ?? userRef);
      } else {
        result = { error: `Unknown tool: ${fc.name}` };
      }

      // ✅ Output tool per Responses API: SOLO call_id
      input.push({
        type: "function_call_output",
        call_id: fc.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  return {
    message:
      "Mi sono incartato 😅 Riprova con una richiesta più specifica (es. “aggiungi ingredienti caesar per 2 persone”).",
  };
}
  */

// src/ai/agent.ts
import { env } from "../config/env.js";
import { runAgentOllama } from "./agent.ollama.js";
import type { FrontendIntentHint } from "./services/planner.service.js";
//import { runAgentOpenAI } from "./agent.openai.js"; // se vuoi tenerlo per dopo

export async function runAgent(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<{ message: string }> {

    return runAgentOllama(userRef, userText, intentHint);
  
  //return runAgentOpenAI(userRef, userText);
}
