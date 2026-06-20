// Central model registry.
//
// IMPORTANT: `nvidiaId` values are the model ids passed to NVIDIA's
// OpenAI-compatible endpoint (https://integrate.api.nvidia.com/v1). The ids below
// are the best current mapping for the names you requested. A few of the versions
// you named are ahead of what's published in NVIDIA's catalog today, so treat the
// ids as overridable: verify each against https://build.nvidia.com (open a model →
// "Get API Key" shows the exact id) and update here, or override at runtime with a
// `MODEL_OVERRIDES` JSON var without touching code. Nothing else in the app
// hard-codes a model id — everything resolves through this file.

export type ModelRole = 'coder' | 'router' | 'guard';

export interface ModelDef {
  /** Friendly id used in the UI and API ("model" field in requests). */
  id: string;
  /** Display label. */
  label: string;
  /** NVIDIA NIM model id sent to the inference endpoint. */
  nvidiaId: string;
  role: ModelRole;
  /** One-line pitch shown in the model picker. */
  blurb: string;
  /** "pro" models are heavier/slower; auto-router prefers them for complex asks. */
  tier: 'flash' | 'standard' | 'pro';
  /** Hidden from the picker (router/guard utility models). */
  internal?: boolean;
}

export const CODER_MODELS: ModelDef[] = [
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    nvidiaId: 'moonshotai/kimi-k2-instruct',
    role: 'coder',
    tier: 'pro',
    blurb: 'Strong long-context reasoning. Great for big, multi-feature apps.',
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    nvidiaId: 'minimaxai/minimax-m3',
    role: 'coder',
    tier: 'standard',
    blurb: 'Balanced speed and quality for everyday UI builds.',
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    nvidiaId: 'deepseek-ai/deepseek-v4-flash',
    role: 'coder',
    tier: 'flash',
    blurb: 'Fastest. Best for quick tweaks and small components.',
  },
  {
    id: 'step-3.7-flash',
    label: 'Step 3.7 Flash',
    nvidiaId: 'stepfun-ai/step-3.7-flash',
    role: 'coder',
    tier: 'flash',
    blurb: 'Snappy generations with solid front-end instincts.',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    nvidiaId: 'deepseek-ai/deepseek-v4',
    role: 'coder',
    tier: 'pro',
    blurb: 'Top-tier code quality for complex logic and refactors.',
  },
  {
    id: 'glm-5.1',
    label: 'GLM 5.1',
    nvidiaId: 'zai/glm-5.1',
    role: 'coder',
    tier: 'standard',
    blurb: 'Reliable all-rounder with clean, idiomatic output.',
  },
];

// Picks the best coder model for a given prompt in Auto mode.
export const ROUTER_MODEL: ModelDef = {
  id: 'auto',
  label: 'Auto (best for prompt)',
  nvidiaId: 'openai/gpt-oss-20b',
  role: 'router',
  tier: 'flash',
  blurb: 'Yield picks the best model for each prompt.',
  internal: true,
};

// Reviews every prompt for exploit/jailbreak attempts before generation.
export const GUARD_MODEL: ModelDef = {
  id: 'nemoguard',
  label: 'NeMoGuard JailbreakDetect',
  nvidiaId: 'nvidia/nemoguard-jailbreak-detect',
  role: 'guard',
  tier: 'flash',
  blurb: 'NVIDIA jailbreak detector.',
  internal: true,
};

const BY_ID: Record<string, ModelDef> = Object.fromEntries(
  [...CODER_MODELS, ROUTER_MODEL, GUARD_MODEL].map((m) => [m.id, m]),
);

/** Apply optional runtime overrides of nvidiaId via a MODEL_OVERRIDES JSON var. */
export function resolveModel(id: string, overridesJson?: string): ModelDef {
  const base = BY_ID[id] ?? BY_ID['glm-5.1']; // safe default
  if (!overridesJson) return base;
  try {
    const overrides = JSON.parse(overridesJson) as Record<string, string>;
    if (overrides[base.id]) return { ...base, nvidiaId: overrides[base.id] };
  } catch {
    /* ignore malformed overrides */
  }
  return base;
}

/** Public list for the model picker (coder models + the Auto option). */
export function pickerModels() {
  return [
    { ...ROUTER_MODEL, internal: false },
    ...CODER_MODELS,
  ].map(({ id, label, blurb, tier }) => ({ id, label, blurb, tier }));
}
