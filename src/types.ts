/// <reference types="@cloudflare/workers-types" />

// Bindings + vars available on `env` inside the Worker. Mirrors wrangler.toml.
export interface Env {
  // Bindings
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;

  // Vars
  APP_NAME: string;
  APP_URL: string;
  NVIDIA_CHAT_BASE: string;
  NVIDIA_JAILBREAK_URL: string;
  FREE_REQUEST_BUDGET: string;
  FREE_DAILY_LIMIT: string;
  ANON_DAILY_LIMIT: string;
  HIGH_USAGE_OVERRIDE: string; // 'auto' | 'on' | 'off'
  STRIPE_PRICE_ID: string;

  // Secrets
  NVIDIA_API_KEY: string;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
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
