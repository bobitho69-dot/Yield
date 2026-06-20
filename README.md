# ◆ Yield — a free AI coder

Yield turns chat prompts into working web apps. You describe an app, an NVIDIA-hosted
model generates it, you see it live in a sandboxed preview, and you refine it by chatting
or editing the code directly. Every prompt is screened by NVIDIA NeMoGuard for jailbreak
attempts, your code is saved to your own GitHub repos, and the whole thing runs on
Cloudflare Workers — free, with a "High Usage Times" model so it never costs you a surprise bill.

> Like base44 / Lovable / Bolt, but free, Cloudflare-hosted, and funded only when it has to be.

---

## How it works (in one minute)

1. **Chat** your idea in the builder. Pick a model, or let **Auto** choose the best one.
2. Yield runs the prompt through **NeMoGuard** (jailbreak detector). If it's clean and you're
   within limits, it streams a complete single-file app back, live into the preview.
3. **Edit** by chatting again ("make the button blue") or in the **Code** tab.
4. Sign in to **save** projects, and connect **GitHub** to push every build to your own repo.
5. When Cloudflare usage would start costing money, Yield enters **High Usage Times**: free
   generation pauses for the month, **Priority** members ($20/mo) keep full access — their
   subscription is what funds the busy periods.

---

## The AIs — each is its own API

Configured in [`src/config/models.ts`](src/config/models.ts). **Every AI is wired as its own API:**
it has its own key env var (and can have its own base URL), resolved per-request. Unset keys fall
back to `NVIDIA_API_KEY`, so you can start with one NVIDIA key and split them out later with no code
changes. **Verify each `modelId` at https://build.nvidia.com** (a few versions you named are ahead of
the public catalog, so they're swappable placeholders).

| Role | Yield name | `modelId` (edit to match catalog) | Its API key (env var) |
|------|------------|------------------------------------|------------------------|
| Coder | Kimi K2.6 | `moonshotai/kimi-k2-instruct` | `KIMI_API_KEY` |
| Coder | MiniMax M3 | `minimaxai/minimax-m3` | `MINIMAX_API_KEY` |
| Coder | DeepSeek V4 Flash | `deepseek-ai/deepseek-v4-flash` | `DEEPSEEK_FLASH_API_KEY` |
| Coder | Step 3.7 Flash | `stepfun-ai/step-3.7-flash` | `STEP_API_KEY` |
| Coder | DeepSeek V4 Pro | `deepseek-ai/deepseek-v4` | `DEEPSEEK_PRO_API_KEY` |
| Coder | GLM 5.1 | `zai/glm-5.1` | `GLM_API_KEY` |
| Auto router | gpt-oss-20b | `openai/gpt-oss-20b` | `GPTOSS_API_KEY` |
| Jailbreak guard | NeMoGuard JailbreakDetect | `nvidia/nemoguard-jailbreak-detect` | `NEMOGUARD_API_KEY` |

> All keys fall back to `NVIDIA_API_KEY` if unset. To run an AI on a *different provider*, also set
> `provider.baseUrl` for it in `src/config/models.ts`.

---

## ☑️ External APIs / accounts you need to create

These are the third-party services Yield calls. Create each, then put the keys in
`wrangler secret put …` (production) or `.dev.vars` (local). See `.dev.vars.example`.

| # | Service | What to create | Secret(s) to set | Where |
|---|---------|----------------|------------------|-------|
| 1 | **NVIDIA NIM** | One free developer key powers all 8 AIs | `NVIDIA_API_KEY` (`nvapi-…`) | https://build.nvidia.com → open a model → *Get API Key* |
| 2 | **Per-AI keys** *(optional)* | Separate key per AI if you want isolated quotas/accounts | `KIMI_API_KEY`, `MINIMAX_API_KEY`, `DEEPSEEK_FLASH_API_KEY`, `STEP_API_KEY`, `DEEPSEEK_PRO_API_KEY`, `GLM_API_KEY`, `GPTOSS_API_KEY`, `NEMOGUARD_API_KEY` | https://build.nvidia.com |
| 3 | **GitHub OAuth App** | Login + code storage. Callback: `https://<your-app>/api/auth/github/callback` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | https://github.com/settings/developers |
| 4 | **Google OAuth Client** | Login. Redirect: `https://<your-app>/api/auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | https://console.cloud.google.com/apis/credentials |
| 5 | **Stripe** | A $20/mo recurring **Price** + a **Webhook** to `…/api/billing/webhook` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` (var) | https://dashboard.stripe.com |
| 6 | **Session secret** | Any random string for signing cookies / encrypting GitHub tokens | `SESSION_SECRET` (`openssl rand -hex 32`) | generate locally |

Cloudflare resources you create (no third-party key, just IDs into `wrangler.toml`):
**D1 database** (`npm run db:create`) and **KV namespace** (`npm run kv:create`).

---

## 🔌 The HTTP API (endpoints Yield serves)

Full reference in [`docs/API.md`](docs/API.md). Summary:

### Auth
- `GET  /api/auth/:provider/login` — start GitHub/Google OAuth (`?scope=repo&store_token=1` to also connect code storage)
- `GET  /api/auth/:provider/callback` — OAuth callback → creates session
- `POST /api/auth/logout`
- `GET  /api/auth/me` — current user

### AI / generation
- `POST /api/generate` — **prompt → app**, streamed as SSE (jailbreak guard → gate → auto-route → codegen → save → GitHub sync)
- `POST /api/route` — auto-pick the best coder model for a prompt (gpt-oss-20b)
- `GET  /api/models` — list pickable models (+ Auto)

### Projects
- `GET    /api/projects` — list your projects
- `POST   /api/projects` — create
- `GET    /api/projects/:id` — get project + chat history
- `PUT    /api/projects/:id` — save manual code edits / rename
- `DELETE /api/projects/:id` — delete
- `GET    /api/projects/:id/preview` — sandboxed HTML for the preview iframe
- `GET    /p/:id` — public preview (if shared)

### GitHub code storage
- `GET  /api/github/status` — connected? which login?
- `GET  /api/github/repos` — your repos (to link an existing one)
- `POST /api/projects/:id/github` — `{action: create | link | push | unlink}`

### Billing ($20/mo Priority)
- `POST /api/billing/checkout` — Stripe Checkout
- `POST /api/billing/portal` — manage/cancel
- `POST /api/billing/webhook` — Stripe events
- `GET  /api/billing/status` — plan + renewal

### System
- `GET /api/status` — High-Usage state, plan, remaining daily quota
- `GET /api/health`

---

## 🚀 Setup & deploy

```bash
npm install

# 1. Create Cloudflare resources, paste the IDs into wrangler.toml
npm run db:create        # -> copy database_id
npm run kv:create        # -> copy id

# 2. Apply the database schema
npm run db:init          # remote   (or db:init:local for local dev)

# 3. Set secrets (see the table above)
wrangler secret put NVIDIA_API_KEY
wrangler secret put SESSION_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
# and set STRIPE_PRICE_ID + APP_URL in wrangler.toml [vars]

# 4. Run locally / deploy
npm run dev
npm run deploy
```

Local dev: copy `.dev.vars.example` → `.dev.vars` and fill it in.

---

## 💸 "High Usage Times" — how the cost guard works

The whole point: **Yield stays free** and **you never get a surprise Cloudflare bill.**

- A monthly counter (`usage:month:<YYYY-MM>` in KV) tracks generations.
- When it exceeds `FREE_REQUEST_BUDGET` (set comfortably under Cloudflare's free allowance),
  Yield flips to **High Usage Mode**: free + anonymous users are paused until next month;
  **Priority** users keep going.
- Manual control any time without a redeploy: set KV key `flag:high_usage` to `on`/`off`,
  or the `HIGH_USAGE_OVERRIDE` var to `on`/`off`/`auto`.
- Free users also get a per-day cap (`FREE_DAILY_LIMIT`); anonymous trials get `ANON_DAILY_LIMIT`.

Tune all of these in `wrangler.toml [vars]`.

---

## 🛡️ Safety

- Every prompt → **NeMoGuard JailbreakDetect** (plus a local prefilter). Blocked prompts are
  flagged in chat and never reach the coder model.
- Generated apps render inside a **sandboxed iframe** with a strict `sandbox` CSP — untrusted
  generated code can't touch Yield, your cookies, or your account.
- GitHub access tokens are **AES-GCM encrypted at rest** (key derived from `SESSION_SECRET`).

## Architecture

```
public/        static frontend (landing, builder, dashboard, account, pricing, legal)
src/index.ts   Worker entry + router
src/config/    model registry
src/lib/       nvidia, jailbreak, auth, db (D1), usage gate, billing (Stripe), github
src/routes/    generate, projects, auth, billing, github, misc
schema.sql     D1 schema
```
