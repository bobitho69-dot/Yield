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

// ZenMux (https://zenmux.ai) — a second OpenAI-compatible provider (like OpenRouter).
// Its free models all share ONE key: the ZEMUZAPI secret. Base + a per-model provider
// helper so the ZenMux ModelDefs below (and the vision pre-pass) route to the right
// endpoint/key. Model ids are ZenMux "provider/model-name" slugs (free tier ends "-free").
const ZENMUX_BASE = 'https://zenmux.ai/api/v1';
const zenmux = (): ProviderConfig => ({ apiKeyEnv: 'ZEMUZAPI', baseUrl: ZENMUX_BASE });

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
    id: 'qwen3.5-397b',
    label: 'Qwen3.5 397B',
    modelId: 'qwen/qwen3.5-397b-a17b',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: 'Huge 397B MoE (17B active) — elite code quality plus native vision.',
    pros: ['Top-tier code quality', 'Multimodal — understands images', 'Great on large, multi-file apps'],
    cons: ['Slower than flash models', 'Heavier token use', 'Overkill for tiny tweaks'],
    // NVIDIA endpoint (default base URL); key falls back to NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'QWEN_API_KEY' },
  },
  {
    id: 'qwen3.5-122b',
    label: 'Qwen3.5 122B',
    modelId: 'qwen/qwen3.5-122b-a10b',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: 'Mid-size 122B MoE (10B active) — fast, capable, with vision.',
    pros: ['Fast for its quality', 'Multimodal — understands images', 'Great everyday all-rounder'],
    cons: ['Less depth than the 397B on hard logic', 'Newer / less battle-tested'],
    // NVIDIA endpoint (default base URL); key falls back to NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'QWEN_API_KEY' },
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
    label: 'Gemma 4 31B',
    modelId: 'google/gemma-4-31b-it',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: "Google's Gemma 4 31B — fast, capable open model for everyday apps.",
    pros: ['Fast for its size', 'Solid for everyday apps & UI', 'Good instruction-following'],
    cons: ['Smaller than the flagship coders', 'Less depth on complex logic'],
    // NVIDIA endpoint. Key resolves from GEMMA_API_KEY, a secret named after the
    // model id (google/gemma-4-31b-it), or NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'GEMMA_API_KEY' },
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
  {
    id: 'nemotron-3-ultra',
    label: 'Nemotron 3 Ultra 550B',
    modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
    role: 'coder',
    tier: 'pro',
    speed: 1,
    blurb: "NVIDIA's flagship Nemotron 3 Ultra (550B) — top-tier reasoning & code.",
    pros: ['Elite reasoning & code quality', 'Excels at complex, multi-file apps', 'Huge knowledge'],
    cons: ['Slowest (very large model)', 'Heavier token use', 'Overkill for tiny tweaks'],
    // NVIDIA endpoint (default base URL). The key resolver also matches a secret
    // named exactly after the modelId, and falls back to NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'NEMOTRON_API_KEY' },
  },
  // --- ZenMux free models (OpenAI-compatible; share the ZEMUZAPI key) ------------
  // TEXT/CODE models only. ZenMux's image/vision models (GLM-4.6V, Gemini image) are
  // NOT here — image models are for image/vision, never coding (see visionEndpoint).
  {
    id: 'claude-sonnet-5-free',
    label: 'Claude Sonnet 5 (free)',
    modelId: 'anthropic/claude-sonnet-5-free',
    role: 'coder',
    tier: 'pro',
    speed: 3,
    blurb: "Anthropic's Claude Sonnet 5 — elite coding & reasoning, free via ZenMux.",
    pros: ['Free to use', 'Top-tier code quality & reasoning', 'Great on large, multi-file apps'],
    cons: ['Free tier is rate-limited', 'Heavier token use', 'Needs a ZenMux key (ZEMUZAPI)'],
    provider: zenmux(),
  },
  {
    id: 'claude-fable-5-free',
    label: 'Claude Fable 5 (free)',
    modelId: 'anthropic/claude-fable-5-free',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: "Anthropic's Claude Fable 5 — fast, capable, clean output. Free via ZenMux.",
    pros: ['Free to use', 'Fast for its quality', 'Clean, idiomatic code'],
    cons: ['Free tier is rate-limited', 'Less depth than Sonnet on hard logic', 'Needs a ZenMux key (ZEMUZAPI)'],
    provider: zenmux(),
  },
  {
    id: 'glm-4.7-flash-free',
    label: 'GLM 4.7 Flash (free)',
    modelId: 'z-ai/glm-4.7-flash-free',
    role: 'coder',
    tier: 'flash',
    speed: 5,
    blurb: 'Z.ai GLM-4.7 Flash — snappy coder with clean output. Free via ZenMux.',
    pros: ['Free to use', 'Very fast', 'Good everyday all-rounder'],
    cons: ['Free tier is rate-limited', 'Less depth on complex logic', 'Needs a ZenMux key (ZEMUZAPI)'],
    provider: zenmux(),
  },
  {
    id: 'step-3.7-flash-free',
    label: 'Step 3.7 Flash (free)',
    modelId: 'stepfun/step-3.7-flash-free',
    role: 'coder',
    tier: 'flash',
    speed: 5,
    blurb: 'StepFun Step 3.7 Flash — fast, good front-end instincts. Free via ZenMux.',
    pros: ['Free to use', 'Fast', 'Nice default visuals / layout sense'],
    cons: ['Free tier is rate-limited', 'Can miss edge cases', 'Needs a ZenMux key (ZEMUZAPI)'],
    provider: zenmux(),
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

// Vision model — interprets user-uploaded images. It runs as a PRE-PASS that turns
// the image(s) into a detailed text description, which is then fed to the coder model
// (so any coder, even text-only ones, can "use" an uploaded screenshot/mockup/logo).
// NVIDIA-hosted (OpenAI-compatible, reuses NVIDIA_API_KEY); the exact id is overridable
// via the VISION_MODEL env var. Verify the current id at build.nvidia.com.
const DEFAULT_VISION_MODEL = 'qwen/qwen3.5-397b-a17b';
export function visionModelId(env: Env): string {
  return (env.VISION_MODEL && env.VISION_MODEL.trim()) || DEFAULT_VISION_MODEL;
}

// Vision / image models that live on ZenMux (NOT NVIDIA). These are image-understanding
// (VLM) models — used ONLY for the vision pre-pass, never as coders. Set VISION_MODEL to
// one of these to run the pre-pass on ZenMux (key: ZEMUZAPI).
const ZENMUX_VISION = new Set<string>([
  'z-ai/glm-4.6v-flash-free',
  'z-ai/glm-4.6v-flash',
  'google/gemini-3.1-flash-lite-image-free',
]);

/**
 * Resolve the vision pre-pass endpoint/key for the configured VISION_MODEL. Defaults to
 * NVIDIA (the shared key + backup). If VISION_MODEL is a ZenMux vision model, routes to
 * ZenMux with the ZEMUZAPI key so an image model on a different provider "just works".
 */
export function visionEndpoint(env: Env): { baseUrl: string; apiKey: string; apiKeyBackup?: string; modelId: string } {
  const modelId = visionModelId(env);
  if (ZENMUX_VISION.has(modelId)) {
    return { baseUrl: ZENMUX_BASE, apiKey: envGet(env, 'ZEMUZAPI') || env.NVIDIA_API_KEY, modelId };
  }
  return { baseUrl: env.NVIDIA_CHAT_BASE, apiKey: env.NVIDIA_API_KEY, apiKeyBackup: env.NVIDIA_API_KEY_BACKUP || undefined, modelId };
}

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
 * Resolve a model's API key. The whole NVIDIA catalog shares NVIDIA_API_KEY (no
 * per-model keys). Models on a DIFFERENT provider endpoint (e.g. OpenRouter) use that
 * provider's key, falling back to the NVIDIA key.
 */
export function keyForModel(env: Env, model: ModelDef): string {
  if (model.provider.baseUrl) return envGet(env, model.provider.apiKeyEnv) || env.NVIDIA_API_KEY;
  return env.NVIDIA_API_KEY;
}

/**
 * Resolve a model's endpoint, key, and id. For NVIDIA-hosted models we also return a
 * backup key (NVIDIA_API_KEY_BACKUP) the client falls back to on a rate-limit / quota
 * (429/402) so one key hitting its limit doesn't break the build.
 */
export function endpointFor(env: Env, model: ModelDef): { baseUrl: string; apiKey: string; apiKeyBackup?: string; modelId: string } {
  const baseUrl = model.provider.baseUrl || env.NVIDIA_CHAT_BASE;
  const apiKeyBackup = model.provider.baseUrl ? undefined : (env.NVIDIA_API_KEY_BACKUP || undefined);
  return { baseUrl, apiKey: keyForModel(env, model), apiKeyBackup, modelId: model.modelId };
}

/** Public list for the model picker (Auto + coder models, with pros/cons). */
export function pickerModels() {
  return [{ ...ROUTER_MODEL, internal: false }, ...CODER_MODELS].map(
    ({ id, label, blurb, tier, speed, pros, cons }) => ({ id, label, blurb, tier, speed, pros, cons }),
  );
}
