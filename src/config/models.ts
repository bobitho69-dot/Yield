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
  /**
   * Name of an env var holding THIS AI's base URL, resolved at request time. Used for a
   * SELF-HOSTED model (e.g. Yield AI) whose endpoint isn't known until you stand up the
   * server. Takes effect when `baseUrl` isn't a static string. Falls back to NVIDIA_CHAT_BASE.
   */
  baseUrlEnv?: string;
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
   * Name of an env var holding the served model id, resolved at request time. For a
   * SELF-HOSTED model (Yield AI) whose served name you choose when you launch the server
   * (e.g. `--served-model-name yield-ai`). Falls back to `modelId` when unset.
   */
  modelIdEnv?: string;
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
  /**
   * Alternate providers hosting the SAME model, tried AFTER the primary provider (and its
   * backup key) fail — e.g. the same model on a second provider. Lets one picker entry
   * survive a provider outage instead of listing the model twice. Each alt is only tried
   * when its key env var is actually set (so an unconfigured provider is skipped).
   */
  alt?: { baseUrl: string; apiKeyEnv: string; modelId: string }[];
  /** Hidden from the picker (router/guard utility models). */
  internal?: boolean;
}

// ZenMux (https://zenmux.ai) — a second OpenAI-compatible provider (like OpenRouter).
// Its free models all share ONE key: the ZEMUZAPI secret. Base + a per-model provider
// helper so the ZenMux ModelDefs below (and the vision pre-pass) route to the right
// endpoint/key. Model ids are ZenMux "provider/model-name" slugs (free tier ends "-free").
const ZENMUX_BASE = 'https://zenmux.ai/api/v1';
const zenmux = (): ProviderConfig => ({ apiKeyEnv: 'ZEMUZAPI', baseUrl: ZENMUX_BASE });

// ─── Yield AI — the first-party, in-house model ────────────────────────────────
// This is NOT a third-party API. It's Yield's OWN model, self-hosted on hardware YOU
// control (a rented cloud GPU running vLLM — see /yield-ai). The app talks only to your
// server: no external AI provider is involved. Its endpoint + served id aren't known
// until you stand the server up, so both resolve from env at request time:
//   YIELD_AI_BASE_URL   e.g. https://<your-gpu-host>:8000/v1   (OpenAI-compatible)
//   YIELD_AI_API_KEY    the key you pass vLLM's --api-key (optional; blank if none)
//   YIELD_AI_MODEL_ID   the --served-model-name you launched with (default: yield-ai)
// Until YIELD_AI_BASE_URL is set it's hidden from the picker (see activeCoderModels),
// so it never shows as a broken option before the server exists.
export const YIELD_AI_MODEL: ModelDef = {
  id: 'yield-ai',
  label: 'Yield AI 1.1 (beta)',
  modelId: 'yield-ai',
  modelIdEnv: 'YIELD_AI_MODEL_ID',
  role: 'coder',
  // A small in-house base model — NOT a flagship. Kept in the 'flash' tier so it's never
  // sorted or presented as a top-quality coder; Auto and the fallback ladder never pick it.
  tier: 'flash',
  speed: 3,
  blurb: "Yield's own small in-house model — private & self-hosted. Best for quick, simple chat; pick a hosted model (or Auto) for real coding.",
  pros: ['In-house & private — runs on your own server', 'No external AI API involved', 'Yours to fine-tune and specialize'],
  cons: ['A small model — much weaker than the hosted coders, especially on real code', 'Can ramble or repeat on vague prompts', 'Experimental — use Auto or a hosted model for anything serious'],
  provider: { apiKeyEnv: 'YIELD_AI_API_KEY', baseUrlEnv: 'YIELD_AI_BASE_URL' },
};

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
    // NVIDIA primary; if it's unavailable (after the backup key), fall back to the SAME
    // model free on ZenMux (only when ZEMUZAPI is set). One entry, no duplicate in the picker.
    provider: { apiKeyEnv: 'STEP_API_KEY' },
    alt: [{ baseUrl: ZENMUX_BASE, apiKeyEnv: 'ZEMUZAPI', modelId: 'stepfun/step-3.7-flash-free' }],
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
    id: 'glm-5.2',
    label: 'GLM 5.2',
    modelId: 'z-ai/glm-5.2',
    role: 'coder',
    tier: 'pro',
    speed: 3,
    blurb: 'Latest GLM — sharper reasoning and stronger multi-file coding.',
    pros: ['Strong reasoning & code quality', 'Great on larger, multi-file apps', 'Clean, idiomatic output'],
    cons: ['Heavier than the flash models', 'Overkill for tiny tweaks'],
    // NVIDIA endpoint (default base URL); key resolves from GLM_API_KEY or NVIDIA_API_KEY.
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
    blurb: 'Massive 480B MoE coder (35B active) — elite code quality, free to use.',
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
    blurb: "Gemma 4 31B — fast, capable open model for everyday apps.",
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
    blurb: "Laguna M.1 — a code-specialist model, free to use.",
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
    blurb: "Flagship Nemotron 3 Ultra (550B) — top-tier reasoning & code.",
    pros: ['Elite reasoning & code quality', 'Excels at complex, multi-file apps', 'Huge knowledge'],
    cons: ['Slowest (very large model)', 'Heavier token use', 'Overkill for tiny tweaks'],
    // NVIDIA endpoint (default base URL). The key resolver also matches a secret
    // named exactly after the modelId, and falls back to NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'NEMOTRON_API_KEY' },
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    modelId: 'openai/gpt-oss-120b',
    role: 'coder',
    tier: 'pro',
    speed: 2,
    blurb: "OpenAI's open 120B MoE — strong reasoning & coding. Apache 2.0.",
    pros: ['Elite open-weights reasoning', 'Great on complex, multi-file apps', 'Apache 2.0 — fully open'],
    cons: ['Heavier / slower', 'Overkill for tiny tweaks'],
    // NVIDIA endpoint; shares the router's GPTOSS key, falling back to NVIDIA_API_KEY.
    provider: { apiKeyEnv: 'GPTOSS_API_KEY' },
  },
  {
    id: 'gpt-oss-20b',
    label: 'GPT-OSS 20B',
    modelId: 'openai/gpt-oss-20b',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: "OpenAI's open 20B MoE — fast, efficient reasoning & code. Apache 2.0.",
    pros: ['Fast & efficient MoE', 'Apache 2.0 — fully open (great fine-tune base)', 'Solid everyday all-rounder'],
    cons: ['Less depth than the 120B on hard logic', 'Newer / less battle-tested'],
    provider: { apiKeyEnv: 'GPTOSS_API_KEY' },
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
    blurb: "Claude Sonnet 5 — elite coding & reasoning, free to use.",
    pros: ['Free to use', 'Top-tier code quality & reasoning', 'Great on large, multi-file apps'],
    cons: ['Free tier is rate-limited', 'Heavier token use', 'Best for non-urgent builds'],
    provider: zenmux(),
  },
  {
    id: 'claude-fable-5-free',
    label: 'Claude Fable 5 (free)',
    modelId: 'anthropic/claude-fable-5-free',
    role: 'coder',
    tier: 'standard',
    speed: 4,
    blurb: "Claude Fable 5 — fast, capable, clean output. Free to use.",
    pros: ['Free to use', 'Fast for its quality', 'Clean, idiomatic code'],
    cons: ['Free tier is rate-limited', 'Less depth than Sonnet on hard logic', 'Best for non-urgent builds'],
    provider: zenmux(),
  },
  {
    id: 'glm-4.7-flash-free',
    label: 'GLM 4.7 Flash (free)',
    modelId: 'z-ai/glm-4.7-flash-free',
    role: 'coder',
    tier: 'flash',
    speed: 5,
    blurb: 'GLM 4.7 Flash — snappy coder with clean output. Free to use.',
    pros: ['Free to use', 'Very fast', 'Good everyday all-rounder'],
    cons: ['Free tier is rate-limited', 'Less depth on complex logic', 'Best for non-urgent builds'],
    provider: zenmux(),
  },
  // NOTE: ZenMux's Step 3.7 Flash is NOT a separate entry — it's the alt-provider fallback
  // on the NVIDIA "step-3.7-flash" model above (avoids a duplicate in the picker).
];

// Auto router — analyzes the prompt and picks the best coder model.
export const ROUTER_MODEL: ModelDef = {
  id: 'auto',
  label: 'Auto',
  modelId: 'openai/gpt-oss-20b',
  role: 'router',
  tier: 'flash',
  speed: 5,
  blurb: 'Reads your prompt and picks the best model for the job.',
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
  [...CODER_MODELS, YIELD_AI_MODEL, ROUTER_MODEL, GUARD_MODEL].map((m) => [m.id, m]),
);

/** True once Yield AI has a backend: either the Cloudflare Workers AI binding
 *  (YIELD_AI_BACKEND=workers-ai + [ai] binding) or a self-hosted endpoint (YIELD_AI_BASE_URL). */
export function isYieldAIConfigured(env: Env): boolean {
  if ((env.YIELD_AI_BACKEND || '').trim().toLowerCase() === 'workers-ai' && (env as { AI?: unknown }).AI) return true;
  return !!(envGet(env, 'YIELD_AI_BASE_URL') || '').trim();
}

/**
 * True once at least one HOSTED provider key is configured — i.e. the strong models can
 * actually run. NVIDIA_API_KEY unlocks the whole NVIDIA catalog + Auto router + guard;
 * ZEMUZAPI unlocks the free ZenMux models (Claude Sonnet 5, …); OPENROUTER_API_KEY unlocks
 * Qwen3 Coder / Laguna. When NONE are set, the only working model is the keyless in-house
 * Yield AI (Workers AI) — which is weak — so callers surface a clear "set a key" message
 * instead of failing with a bare 401 that reads like the app is broken.
 */
export function hostedAIConfigured(env: Env): boolean {
  return !!(
    (envGet(env, 'NVIDIA_API_KEY') || '').trim() ||
    (envGet(env, 'ZEMUZAPI') || '').trim() ||
    (envGet(env, 'OPENROUTER_API_KEY') || '').trim()
  );
}

/**
 * The coder models that are actually offered right now. Yield AI (the small in-house model)
 * is appended LAST — offered but never featured — ONLY when its server is configured;
 * otherwise it's omitted so it never appears as a dead option. The strong hosted roster
 * leads, so users land on capable models by default instead of the weak in-house one.
 */
export function activeCoderModels(env: Env): ModelDef[] {
  return isYieldAIConfigured(env) ? [...CODER_MODELS, YIELD_AI_MODEL] : CODER_MODELS;
}

/** Apply optional runtime overrides of modelId via a MODEL_OVERRIDES JSON var. */
export function resolveModel(id: string, overridesJson?: string): ModelDef {
  const base = BY_ID[id] ?? BY_ID['glm-5.2']; // safe default
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

/** A model lives on its own endpoint (not the shared NVIDIA one) when it declares a
 *  static baseUrl OR an env-resolved one (self-hosted). */
function hasOwnEndpoint(model: ModelDef): boolean {
  return !!(model.provider.baseUrl || model.provider.baseUrlEnv);
}

/**
 * Resolve a model's API key. The whole NVIDIA catalog shares NVIDIA_API_KEY (no
 * per-model keys). Models on a DIFFERENT provider endpoint (e.g. OpenRouter, or the
 * self-hosted Yield AI) use that provider's key, falling back to the NVIDIA key.
 */
export function keyForModel(env: Env, model: ModelDef): string {
  if (hasOwnEndpoint(model)) return envGet(env, model.provider.apiKeyEnv) || env.NVIDIA_API_KEY;
  return env.NVIDIA_API_KEY;
}

/**
 * Resolve a model's endpoint, key, and id. For NVIDIA-hosted models we also return a
 * backup key (NVIDIA_API_KEY_BACKUP) the client falls back to on a rate-limit / quota
 * (429/402) so one key hitting its limit doesn't break the build.
 */
export type Endpoint = { baseUrl: string; apiKey: string; apiKeyBackup?: string; modelId: string };

export function endpointFor(env: Env, model: ModelDef): Endpoint {
  // Base URL: a static provider URL, else an env-resolved one (self-hosted Yield AI),
  // else NVIDIA's shared endpoint.
  const baseUrl =
    model.provider.baseUrl ||
    (model.provider.baseUrlEnv ? (envGet(env, model.provider.baseUrlEnv) || '').trim() : '') ||
    env.NVIDIA_CHAT_BASE;
  // The NVIDIA backup key only makes sense on the NVIDIA endpoint.
  const apiKeyBackup = hasOwnEndpoint(model) ? undefined : (env.NVIDIA_API_KEY_BACKUP || undefined);
  // Served model id: an env-provided name (self-hosted --served-model-name) wins over the
  // static default so the same def works whatever you launched the server as.
  const modelId = (model.modelIdEnv ? (envGet(env, model.modelIdEnv) || '').trim() : '') || model.modelId;
  return { baseUrl, apiKey: keyForModel(env, model), apiKeyBackup, modelId };
}

/**
 * The ordered endpoint chain for a model: the primary provider first (which itself tries
 * its key then the NVIDIA backup key), then any alternate providers hosting the SAME model.
 * An alt is included ONLY when its key env var is set — so an unconfigured provider is
 * skipped rather than wasting a doomed request. Callers try each in order until one works.
 */
export function endpointsFor(env: Env, model: ModelDef): Endpoint[] {
  const chain: Endpoint[] = [endpointFor(env, model)];
  for (const a of model.alt ?? []) {
    const key = envGet(env, a.apiKeyEnv);
    if (!key) continue; // alt provider isn't configured — skip it
    chain.push({ baseUrl: a.baseUrl, apiKey: key, modelId: a.modelId });
  }
  return chain;
}

/** Public list for the model picker (Auto + coder models, with pros/cons). When `env`
 *  is given, the in-house Yield AI is included (featured first) once its server is
 *  configured; without `env`, the standard hosted roster is returned. */
export function pickerModels(env?: Env) {
  const coders = env ? activeCoderModels(env) : CODER_MODELS;
  return [{ ...ROUTER_MODEL, internal: false }, ...coders].map(
    ({ id, label, blurb, tier, speed, pros, cons }) => ({ id, label, blurb, tier, speed, pros, cons }),
  );
}
