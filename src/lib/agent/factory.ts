import type { LLM } from "./llm.js";
import { OpenAICompatibleLLM } from "./openai.js";
import { ScriptedLLM } from "./scripted.js";

/**
 * Selects an LLM from the environment.
 *
 * Default is `scripted`, so nothing in this project ever requires a key or the
 * network to run. Set `LLM_ADAPTER=openai` with `LLM_API_KEY` (and optionally
 * `LLM_MODEL`, `LLM_BASE_URL`) to drive journeys and scenario generation with a
 * real model.
 */
export function llmFromEnv(): LLM {
  const adapter = (process.env.LLM_ADAPTER ?? "scripted").toLowerCase();
  if (adapter === "scripted") return new ScriptedLLM();

  if (adapter === "openai") {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LLM_ADAPTER=openai requires LLM_API_KEY. Unset LLM_ADAPTER to run " +
          "with the deterministic scripted model instead.",
      );
    }
    const config: {
      apiKey: string;
      model: string;
      baseUrl?: string;
    } = {
      apiKey,
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    };
    if (process.env.LLM_BASE_URL) config.baseUrl = process.env.LLM_BASE_URL;
    return new OpenAICompatibleLLM(config);
  }

  throw new Error(`Unknown LLM_ADAPTER: ${adapter}`);
}

export function isRealLlmConfigured(): boolean {
  return (
    (process.env.LLM_ADAPTER ?? "").toLowerCase() === "openai" &&
    Boolean(process.env.LLM_API_KEY)
  );
}
