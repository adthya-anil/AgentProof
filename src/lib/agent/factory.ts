import { AnthropicLLM } from "./anthropic.js";
import type { LLM } from "./llm.js";
import { OpenAICompatibleLLM } from "./openai.js";
import { ScriptedLLM } from "./scripted.js";

/**
 * Selects an LLM from the environment.
 *
 * Default is `scripted`, so nothing in this project ever requires a key or the
 * network to run. Set `LLM_ADAPTER=openai` or `LLM_ADAPTER=anthropic` with the
 * matching credentials to drive journeys and scenario generation with a real
 * model.
 */
/**
 * Reads an environment variable, treating blank as absent.
 *
 * `.env.example` ships every key as a bare `KEY=` line, so a variable that was
 * never filled in arrives as `""` rather than undefined. `??` does not fall
 * through on an empty string, which would turn "I left this blank" into a hard
 * configuration error instead of a fallback.
 */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export function llmFromEnv(): LLM {
  const adapter = (env("LLM_ADAPTER") ?? "scripted").toLowerCase();
  if (adapter === "scripted") return new ScriptedLLM();
  if (adapter === "openai") return openAiFromEnv();
  if (adapter === "anthropic") return anthropicFromEnv();
  throw new Error(`Unknown LLM_ADAPTER: ${adapter}`);
}

function openAiFromEnv(): OpenAICompatibleLLM {
  const apiKey = env("LLM_API_KEY");
  if (!apiKey) {
    throw new Error(
      "LLM_ADAPTER=openai requires LLM_API_KEY. Unset LLM_ADAPTER to run " +
        "with the deterministic scripted model instead.",
    );
  }
  const config: { apiKey: string; model: string; baseUrl?: string } = {
    apiKey,
    model: env("LLM_MODEL") ?? "gpt-4o-mini",
  };
  const baseUrl = env("LLM_BASE_URL");
  if (baseUrl) config.baseUrl = baseUrl;
  return new OpenAICompatibleLLM(config);
}

/**
 * Builds the Anthropic adapter, falling back to the shared `LLM_*` credentials.
 *
 * The fallback is deliberate. On Azure AI Foundry both families sit behind one
 * resource and one key, so requiring a separate `ANTHROPIC_API_KEY` would mean
 * pasting the same secret twice — and a second copy of a secret is a second thing
 * to forget to rotate.
 */
function anthropicFromEnv(): AnthropicLLM {
  const apiKey = env("ANTHROPIC_API_KEY") ?? env("LLM_API_KEY");
  if (!apiKey) {
    throw new Error(
      "LLM_ADAPTER=anthropic requires ANTHROPIC_API_KEY (or LLM_API_KEY). " +
        "Unset LLM_ADAPTER to run with the deterministic scripted model instead.",
    );
  }
  const config: { apiKey: string; model: string; baseUrl?: string } = {
    apiKey,
    model: env("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5",
  };
  const baseUrl = env("ANTHROPIC_BASE_URL");
  if (baseUrl) config.baseUrl = baseUrl;
  return new AnthropicLLM(config);
}

export function isRealLlmConfigured(): boolean {
  const adapter = (env("LLM_ADAPTER") ?? "").toLowerCase();
  if (adapter === "openai") return Boolean(env("LLM_API_KEY"));
  if (adapter === "anthropic") {
    return Boolean(env("ANTHROPIC_API_KEY") ?? env("LLM_API_KEY"));
  }
  return false;
}

/**
 * Every real model the environment can reach, for driving journeys.
 *
 * A merchant does not get to choose which agent shops their store, so testing
 * against a single model tests a narrower world than the one they ship into. When
 * two families are configured, live-agent journeys are dealt across both and each
 * journey records which model drove it — so a finding can be attributed to a model
 * rather than to "an AI".
 *
 * Order is stable so a run is reproducible in composition even though the models
 * themselves are not. Returns the scripted model when nothing real is configured,
 * because an empty pool would mean no journeys at all.
 */
export function llmPoolFromEnv(): LLM[] {
  const pool: LLM[] = [];

  const adapter = (env("LLM_ADAPTER") ?? "scripted").toLowerCase();

  if (env("LLM_API_KEY") && adapter !== "scripted" && adapter !== "anthropic") {
    try {
      pool.push(openAiFromEnv());
    } catch {
      // A half-configured provider is not a reason to abandon the other one.
    }
  }

  // Included whenever a model name is set, or when the primary adapter is
  // Anthropic. Opting in by naming the deployment avoids guessing at a model id
  // on a key that may not have Anthropic access at all.
  const wantsAnthropic =
    Boolean(env("ANTHROPIC_MODEL")) ||
    Boolean(env("ANTHROPIC_API_KEY")) ||
    adapter === "anthropic";
  if (wantsAnthropic) {
    try {
      pool.push(anthropicFromEnv());
    } catch {
      // Same reasoning as above.
    }
  }

  return pool.length > 0 ? pool : [new ScriptedLLM()];
}

/** Human-readable summary of the pool, for a report header. */
export function describePool(pool: readonly LLM[]): string {
  return pool.map((llm) => llm.name).join(" + ");
}
