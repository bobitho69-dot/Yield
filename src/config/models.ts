// Central model registry.
//
// Each AI is its OWN API: a model carries its own `provider` (base URL + which env
// var holds its key) plus the `modelId` sent to that endpoint. They all default to
// the shared NVIDIA OpenAI-compatible endpoint, but any model can point at a
// different base URL / key without touching code — set `provider.baseUrl` and
// `provider.apiKeyEnv` here (and add that secret).
//
// IMPORTANT: a few versions you named are ahead of NVIDIA's public catalog, so the
// `modelId`s are best-effort placeholders. Verify each at https://build.nvidia.com
// (open a model → "Get API Key" shows the exact id) and update here, or override at
// runtime with a MODEL_OVERRIDES JSON var. Nothing else hard-codes a model id.

import type { Env } from '../types';

export type ModelRole = 'coder' | 'router' | 'guard';

export interface ProviderConfig {
  /** OpenAI-compatible base URL. Defaults to env.NVIDIA_CHAT_BASE. */
  baseUrl?: string;
  /** Name of the env var holding this API's key. Defaults to 'NVIDIA_API_KEY'. */
  apiKeyEnv?: string;
}

export interface ModelDef {
  /** Friendly id used in the UI and API ("model" field in requests). */
  id: string;
  label: string;
  /** Model id sent to the provider endpoint. */
  modelId: string;
  role: ModelRole;
  /** One-line pitch. */
  blurb: string;
  /** "pro" models are heavier/slower; the router prefers them for complex asks. */
  tier: 'flash' | 'standard' | 'pro';
  /** Relative speed for the UI meter (1 = slowest … 5 = fastest). */
  speed: number;
  pros: string[];
  cons: string[];
  /** Per-model API endpoint + key. */
  provider: ProviderConfig;
  /** Hidden from the picker (router/guard utility models). */
  internal?: boolean;
}

// Default provider = shared NVIDIA endpoint/key. Override per model as needed.
const NVIDIA: ProviderConfig = { /* baseUrl: env.NVIDIA_CHAT_BASE, apiKeyEnv: 'NVIDIA_API_KEY' */ };

export const CODER_MODELS: ModelDef[] = [
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    modelId: 'moonshotai/kimi-k2-instruct',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Strong long-context reasoning. Great for big, multi-feature apps.',
    pros: ['Huge context — handles large apps', 'Excellent at multi-step logic', 'Coherent across many features'],
    cons: ['Slower to respond', 'Uses more tokens', 'Overkill for tiny tweaks'],
    provider: NVIDIA,
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
    provider: NVIDIA,
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
    provider: NVIDIA,
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
    provider: NVIDIA,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    modelId: 'deepseek-ai/deepseek-v4',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Top-tier code quality for complex logic and refactors.',
    pros: ['Best-in-class code quality', 'Handles complex logic & refactors', 'Robust, well-structured output'],
    cons: ['Slower', 'Heavier token use', 'More than you need for simple UIs'],
    provider: NVIDIA,
  },
  {
    id: 'glm-5.1',
    label: 'GLM 5.1',
    modelId: 'zai/glm-5.1',
    role: 'coder',
    tier: 'standard',
    speed: 3,
    blurb: 'Reliable all-rounder with clean, idiomatic output.',
    pros: ['Dependable all-rounder', 'Clean, idiomatic code', 'Good instruction-following'],
    cons: ['Rarely the single best at extremes', 'Middle-of-the-road speed'],
    provider: NVIDIA,
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
  provider: NVIDIA,
  internal: true,
};

// Jailbreak guard.
export const GUARD_MODEL: ModelDef = {
  id: 'nemoguard',
  label: 'NeMoGuard JailbreakDetect',
  modelId: 'nvidia/nemoguard-jailbreak-detect',
  role: 'guard',
  tier: 'flash',
  speed: 5,
  blurb: 'NVIDIA jailbreak detector.',
  pros: [],
  cons: [],
  provider: NVIDIA,
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

/** Resolve a model's concrete API endpoint + key + id (each AI is its own API). */
export function endpointFor(env: Env, model: ModelDef): { baseUrl: string; apiKey: string; modelId: string } {
  const baseUrl = model.provider.baseUrl || env.NVIDIA_CHAT_BASE;
  const keyEnv = model.provider.apiKeyEnv || 'NVIDIA_API_KEY';
  const apiKey = (env as unknown as Record<string, string>)[keyEnv] || env.NVIDIA_API_KEY;
  return { baseUrl, apiKey, modelId: model.modelId };
}

/** Public list for the model picker (Auto + coder models, with pros/cons). */
export function pickerModels() {
  return [{ ...ROUTER_MODEL, internal: false }, ...CODER_MODELS].map(
    ({ id, label, blurb, tier, speed, pros, cons }) => ({ id, label, blurb, tier, speed, pros, cons }),
  );
}
