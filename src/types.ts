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

  // Secrets
  NVIDIA_API_KEY: string; // shared default + fallback for every AI below

  // Per-AI keys (optional). Each AI is its own API; unset -> falls back to NVIDIA_API_KEY.
  KIMI_API_KEY?: string;          // Kimi K2.6
  MINIMAX_API_KEY?: string;       // MiniMax M3
  DEEPSEEK_FLASH_API_KEY?: string;// DeepSeek V4 Flash
  STEP_API_KEY?: string;          // Step 3.7 Flash
  DEEPSEEK_PRO_API_KEY?: string;  // DeepSeek V4 Pro
  GLM_API_KEY?: string;           // GLM 5.1
  GPTOSS_API_KEY?: string;        // gpt-oss-20b (Auto router)
  NEMOGUARD_API_KEY?: string;     // NeMoGuard JailbreakDetect
  OPENROUTER_API_KEY?: string;    // Qwen3 Coder / Laguna (via OpenRouter)
  GEMMA_API_KEY?: string;         // Gemma 4 31B (via NVIDIA; or name a secret after the model id)
  NEMOTRON_API_KEY?: string;      // Nemotron 3 Ultra 550B (via NVIDIA; or name a secret after the model id)

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
