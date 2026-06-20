// Central model registry.
//
// EACH AI IS ITS OWN API. Every model carries a `provider` (base URL + the name of
// the env var holding ITS key) plus the `modelId` sent to that endpoint. Each one
// has a distinct key env var so you can use separate keys/accounts/endpoints per AI.
// If a model's key var is unset, it falls back to NVIDIA_API_KEY — so you can start
// with a single NVIDIA key and split them out later with zero code changes.
//
// The coder `modelId`s below are the real NVIDIA catalog ids (verified at
// https://build.nvidia.com — open a model → "Get API Key" shows the exact id). If
// NVIDIA renames one, update it here, or override at runtime with a MODEL_OVERRIDES
// JSON var. Qwen3 Coder runs on OpenRouter (its own provider.baseUrl + key).

import type { Env } from '../types';

export type ModelRole = 'coder' | 'router' | 'guard';

export interface ProviderConfig {
  /** OpenAI-compatible base URL. Defaults to env.NVIDIA_CHAT_BASE. */
  baseUrl?: string;
  /** Name of the env var holding THIS AI's key. Falls back to NVIDIA_API_KEY. */
  apiKeyEnv: string;
}

export interface ModelDef {
  /** Friendly id used in the UI and API ("model" field in requests). */
  id: string;
  label: string;
  /** Model id sent to the provider endpoint (the REAL NVIDIA catalog id). */
  modelId: string;
  /**
   * Name to look the API key up under, in addition to apiKeyEnv. Set this to the
   * secret name you created (often the old model id) so keys still resolve even
   * after `modelId` is corrected. Optional.
   */
  keyName?: string;
  role: ModelRole;
  /** One-line pitch. */
  blurb: string;
  /** "pro" models are heavier/slower; the router prefers them for complex asks. */
  tier: 'flash' | 'standard' | 'pro';
  /** Relative speed for the UI meter (1 = slowest … 5 = fastest). */
  speed: number;
  pros: string[];
  cons: string[];
  /** Per-model API endpoint + key (each AI is its own API). */
  provider: ProviderConfig;
  /** Hidden from the picker (router/guard utility models). */
  internal?: boolean;
}

export const CODER_MODELS: ModelDef[] = [
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    modelId: 'moonshotai/kimi-k2.6',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Strong long-context reasoning. Great for big, multi-feature apps.',
    pros: ['Huge context — handles large apps', 'Excellent at multi-step logic', 'Coherent across many features'],
    cons: ['Slower to respond', 'Uses more tokens', 'Overkill for tiny tweaks'],
    provider: { apiKeyEnv: 'KIMI_API_KEY' },
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    modelId: 'minimaxai/minimax-m3',
    role: 'coder',
    tier: 'standard',
    speed: 3,
    blurb: 'Balanced speed and quality for everyday UI builds.',
    pros: ['Good speed-to-quality balance', 'Reliable for typical apps', 'Clean, modern UI output'],
    cons: ['Not the deepest on complex logic', 'Occasionally generic styling'],
    provider: { apiKeyEnv: 'MINIMAX_API_KEY' },
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    modelId: 'deepseek-ai/deepseek-v4-flash',
    role: 'coder',
    tier: 'flash',
    speed: 5,
    blurb: 'Fastest. Best for quick tweaks and small components.',
    pros: ['Very fast responses', 'Great for quick edits', 'Low token cost'],
    cons: ['Weaker on large, complex apps', 'Less thorough on edge cases'],
    provider: { apiKeyEnv: 'DEEPSEEK_FLASH_API_KEY' },
  },
  {
    id: 'step-3.7-flash',
    label: 'Step 3.7 Flash',
    modelId: 'stepfun-ai/step-3.7-flash',
    role: 'coder',
    tier: 'flash',
    speed: 5,
    blurb: 'Snappy generations with solid front-end instincts.',
    pros: ['Fast', 'Good front-end / layout sense', 'Nice default visuals'],
    cons: ['Less consistent on heavy logic', 'Can miss edge cases'],
    provider: { apiKeyEnv: 'STEP_API_KEY' },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    modelId: 'deepseek-ai/deepseek-v4-pro',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Top-tier code quality for complex logic and refactors.',
    pros: ['Best-in-class code quality', 'Handles complex logic & refactors', 'Robust, well-structured output'],
    cons: ['Slower', 'Heavier token use', 'More than you need for simple UIs'],
    provider: { apiKeyEnv: 'DEEPSEEK_PRO_API_KEY' },
  },
  {
    id: 'glm-5.1',
    label: 'GLM 5.1',
    modelId: 'z-ai/glm-5.1',
    role: 'coder',
    tier: 'standard',
    speed: 3,
    blurb: 'Reliable all-rounder with clean, idiomatic output.',
    pros: ['Dependable all-rounder', 'Clean, idiomatic code', 'Good instruction-following'],
    cons: ['Rarely the single best at extremes', 'Middle-of-the-road speed'],
    provider: { apiKeyEnv: 'GLM_API_KEY' },
  },
  {
    id: 'qwen3-coder',
    label: 'Qwen3 Coder 480B (free)',
    // OpenRouter's FREE Qwen3-Coder-480B-A35B-Instruct (drop ":free" for the paid tier).
    modelId: 'qwen/qwen3-coder:free',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Massive 480B MoE coder (35B active) — elite code quality, free via OpenRouter.',
    pros: ['Free to use', 'Elite coding & agentic ability', 'Excels at complex, multi-file apps'],
    cons: ['Slower (very large model)', 'Free tier is rate-limited', 'Overkill for tiny tweaks'],
    // Its own API on OpenRouter (OpenAI-compatible). Set OPENROUTER_API_KEY.
    provider: { apiKeyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  },
  {
    id: 'gemma-4-31b',
    label: 'Gemma 4 31B (free)',
    modelId: 'google/gemma-4-31b-it:free',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: "Google's Gemma 4 31B — fast, capable open model, free via OpenRouter.",
    pros: ['Free to use', 'Fast for its size', 'Solid for everyday apps & UI'],
    cons: ['Smaller than the flagship coders', 'Free tier is rate-limited'],
    // Same OpenRouter provider + key as Qwen (OpenAI-compatible).
    provider: { apiKeyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  },
  {
    id: 'laguna-m1',
    label: 'Laguna M.1 (free)',
    modelId: 'poolside/laguna-m.1:free',
    role: 'coder',
    tier: 'standard',
    speed: 3,
    blurb: "Poolside's Laguna M.1 — a code-specialist model, free via OpenRouter.",
    pros: ['Free to use', 'Built specifically for code', 'Good at app logic'],
    cons: ['Newer / less battle-tested', 'Free tier is rate-limited'],
    // OpenRouter provider + key (OpenAI-compatible).
    provider: { apiKeyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  },
];

// Auto router — analyzes the prompt and picks the best coder model.
export const ROUTER_MODEL: ModelDef = {
  id: 'auto',
  label: 'Auto',
  modelId: 'openai/gpt-oss-20b',
  role: 'router',
  tier: 'flash',
  speed: 5,
  blurb: 'gpt-oss-20b reads your prompt and picks the best model for it.',
  pros: ['Best model per prompt, automatically', 'No guesswork'],
  cons: ['Adds a small routing step'],
  provider: { apiKeyEnv: 'GPTOSS_API_KEY' },
  internal: true,
};

// Jailbreak guard (its own API: a classify endpoint, not chat completions).
export const GUARD_MODEL: ModelDef = {
  id: 'nemoguard',
  label: 'NeMoGuard JailbreakDetect',
  modelId: 'nvidia/nemoguard-jailbreak-detect',
  role: 'guard',
  tier: 'flash',
  speed: 5,
  blurb: 'NVIDIA jailbreak detector — screens every prompt.',
  pros: [],
  cons: [],
  provider: { apiKeyEnv: 'NEMOGUARD_API_KEY' },
  internal: true,
};

const BY_ID: Record<string, ModelDef> = Object.fromEntries(
  [...CODER_MODELS, ROUTER_MODEL, GUARD_MODEL].map((m) => [m.id, m]),
);

/** Apply optional runtime overrides of modelId via a MODEL_OVERRIDES JSON var. */
export function resolveModel(id: string, overridesJson?: string): ModelDef {
  const base = BY_ID[id] ?? BY_ID['glm-5.1']; // safe default
  if (!overridesJson) return base;
  try {
    const overrides = JSON.parse(overridesJson) as Record<string, string>;
    if (overrides[base.id]) return { ...base, modelId: overrides[base.id] };
  } catch {
    /* ignore malformed overrides */
  }
  return base;
}

function envGet(env: Env, name: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[name];
}

/** Look up an env var by name, falling back to the shared NVIDIA key. */
export function keyFor(env: Env, apiKeyEnv: string): string {
  return envGet(env, apiKeyEnv) || env.NVIDIA_API_KEY;
}

/**
 * Resolve a model's API key, trying several candidate secret names so it works
 * whether you named the secret KIMI_API_KEY (recommended) or after the model id
 * itself (e.g. "moonshotai/kimi-k2-instruct"). Falls back to NVIDIA_API_KEY.
 */
export function keyForModel(env: Env, model: ModelDef): string {
  const candidates = [
    model.provider.apiKeyEnv, // e.g. KIMI_API_KEY
    model.keyName, // the secret name you created (often the old/aliased id)
    model.modelId, // e.g. moonshotai/kimi-k2-instruct
    model.modelId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase(), // MOONSHOTAI_KIMI_K2_INSTRUCT
  ];
  for (const name of candidates) {
    const v = name ? envGet(env, name) : undefined;
    if (v) return v;
  }
  return env.NVIDIA_API_KEY;
}

/** Resolve a model's concrete API endpoint + key + id (each AI is its own API). */
export function endpointFor(env: Env, model: ModelDef): { baseUrl: string; apiKey: string; modelId: string } {
  const baseUrl = model.provider.baseUrl || env.NVIDIA_CHAT_BASE;
  return { baseUrl, apiKey: keyForModel(env, model), modelId: model.modelId };
}

/** Public list for the model picker (Auto + coder models, with pros/cons). */
export function pickerModels() {
  return [{ ...ROUTER_MODEL, internal: false }, ...CODER_MODELS].map(
    ({ id, label, blurb, tier, speed, pros, cons }) => ({ id, label, blurb, tier, speed, pros, cons }),
  );
}
