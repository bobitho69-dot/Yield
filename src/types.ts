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
  // pre-pass that describes them for the coder). NVIDIA-hosted, reuses NVIDIA_API_KEY.
  VISION_MODEL?: string;

  // Secrets
  NVIDIA_API_KEY: string;         // the single key for the whole NVIDIA catalog (every model)
  NVIDIA_API_KEY_BACKUP?: string; // optional 2nd NVIDIA key; used automatically on a 429/402 (rate-limit/quota)

  // The only non-NVIDIA provider: OpenRouter (Qwen3 Coder / Laguna). Optional — those
  // two models just fall back if unset. The old per-model NVIDIA keys are no longer used.
  OPENROUTER_API_KEY?: string;

  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
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
