/// <reference types="@cloudflare/workers-types" />

// Bindings + vars available on `env` inside the Worker. Mirrors wrangler.toml.
export interface Env {
  // Bindings
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  // Durable Object that runs app builds independently of any browser tab, so a
  // build keeps running (and saves) even if the user refreshes or closes the page.
  BUILDER: DurableObjectNamespace;

  // Vars
  APP_NAME: string;
  APP_URL: string;
  NVIDIA_CHAT_BASE: string;
  NVIDIA_JAILBREAK_URL: string;
  FREE_REQUEST_BUDGET: string;
  FREE_DAILY_LIMIT: string;
  ANON_DAILY_LIMIT: string;
  HIGH_USAGE_OVERRIDE: string; // 'auto' | 'on' | 'off'
  AUTH_ENABLED: string; // 'true' = require login; 'false' = open testing mode (guest)
  STRIPE_PRICE_ID: string;
  // Stripe price for the standalone "Yield Security" monthly subscription.
  SECURITY_PRICE_ID: string;
  // Optional donation link (Ko-fi / Buy Me a Coffee / GitHub Sponsors / Stripe
  // Payment Link). When set, Yield shows "Support Yield" links pointing here.
  DONATE_URL?: string;

  // AI image generation (optional). Apps call window.YIELD.image().
  IMAGE_API_URL?: string;
  IMAGE_API_MODEL?: string;

  // AI 3D-model generation (optional). Apps call window.YIELD.model3d() -> a .glb.
  // The NVIDIA-hosted Microsoft TRELLIS endpoint; reuses NVIDIA_API_KEY.
  TRELLIS_API_URL?: string;

  // AI video generation (optional). Apps call window.YIELD.video() -> a video URL.
  // The NVIDIA-hosted endpoint (Cosmos); reuses NVIDIA_API_KEY.
  VIDEO_API_URL?: string;
  VIDEO_API_MODEL?: string;

  // Vision model id (optional). Interprets user-uploaded images in the builder (a
  // pre-pass that describes them for the coder). Defaults to NVIDIA (reuses NVIDIA_API_KEY);
  // set it to a ZenMux vision id (e.g. z-ai/glm-4.6v-flash-free) to run the pre-pass on
  // ZenMux with the ZEMUZAPI key. Vision/image models are used ONLY here, never as coders.
  VISION_MODEL?: string;

  // ── Yield AI — the in-house, self-hosted model (see /yield-ai) ────────────────
  // The OpenAI-compatible base URL of YOUR own model server (vLLM on a rented GPU),
  // e.g. "https://<host>:8000/v1". Set it and "Yield AI" appears in the picker; leave
  // it blank and the model is hidden (no dead option). This is your own box — no
  // third-party AI provider is involved.
  YIELD_AI_BASE_URL?: string;
  // The served model name you launched the server with (vLLM --served-model-name).
  // Defaults to "yield-ai" when unset.
  YIELD_AI_MODEL_ID?: string;

  // Secrets
  NVIDIA_API_KEY: string;         // the single key for the whole NVIDIA catalog (every model)
  NVIDIA_API_KEY_BACKUP?: string; // optional 2nd NVIDIA key; used automatically on a 429/402 (rate-limit/quota)
  // Dedicated key for the security-audit feature (so it can be metered/keyed separately).
  // Optional — falls back to NVIDIA_API_KEY when unset.
  YIELDNVIDIAAIKEY?: string;

  // Non-NVIDIA provider: OpenRouter (Qwen3 Coder / Laguna). Optional — those two models
  // just fall back if unset. The old per-model NVIDIA keys are no longer used.
  OPENROUTER_API_KEY?: string;

  // Non-NVIDIA provider: ZenMux (https://zenmux.ai) — one key for all its free coder
  // models (Claude Sonnet 5 / Fable 5, GLM 4.7 Flash, Step 3.7 Flash) and the ZenMux
  // vision models (GLM-4.6V, Gemini image) when VISION_MODEL points at one. Optional.
  ZEMUZAPI?: string;

  // Yield AI (in-house model): the API key your model server expects, i.e. the value you
  // passed vLLM's `--api-key`. Optional — leave unset if your server has no auth. This is
  // YOUR server's key, not a third-party provider key.
  YIELD_AI_API_KEY?: string;

  // Secret used to sign/verify GitHub webhooks for continuous monitoring (scan-on-push).
  GITHUB_WEBHOOK_SECRET?: string;

  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // "Sign in with Roblox" (OAuth 2.0 / OIDC). Register an app at
  // create.roblox.com → Creator Dashboard → Open Cloud → OAuth 2.0 Apps.
  ROBLOX_CLIENT_ID: string;
  ROBLOX_CLIENT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  IMAGE_API_KEY?: string;
}

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  plan: 'free' | 'priority';
}

// Request context threaded through routes.
export interface Ctx {
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  user: SessionUser | null;
  // Stable per-device id for anonymous rate-limiting (cookie-based).
  deviceId: string;
}
