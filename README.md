# ◆ Yield — a free AI app builder

Yield turns chat prompts into real, working web apps. You describe an app, a frontier AI
model builds it — **multi-file, with a database, AI agents, and live preview** — you watch
the code being written, and you refine it by chatting or editing the code directly. Every
prompt is screened by an automatic jailbreak guard, your code is saved to your own GitHub
repos, and builds run server-side so they finish even if you close the tab. It's free, with a
"High Usage Times" model so it never costs you a surprise bill.

> Everything base44 / Lovable / Replit do — free, with your code on GitHub and nothing locked behind a paywall.

---

## What it can do

- **Chat → full app.** Not a single HTML file — real multi-file projects (HTML/CSS/JS, components, a worker backend) shown in a file tree + editor.
- **Real multi-page apps.** Builds genuine multi-page sites (separate `.html` pages sharing one nav/styles/scripts) with working links between them — preview any page from the toolbar's page picker.
- **Auto-verification.** After every build, a static check catches broken links, missing pages, leftover placeholders and dead buttons — and the AI auto-repairs them before you see the result.
- **Live code view.** Watch each file being written in real time, labelled by which AI is writing it.
- **Pick your thinking level.** 🧠 Fast / Balanced / Max controls how hard the models reason.
- **Builds run in the background.** Each build runs inside a Durable Object, independent of your tab — refresh or close the page and it keeps going (and saves). A reopened tab re-attaches to the live stream.
- **Helper AIs (research).** The coder can launch other AIs to research/plan a tricky part first (a data schema, an algorithm), then build with their findings.
- **Parallel build agents.** For big apps the coder can fan out to several agents that write different files at the same time.
- **AI agents per app.** The coder can create runtime agents your app calls (chatbots, generators, classifiers).
- **Built-in database, secrets, image generation** — exposed to generated apps via `window.YIELD` (see below).
- **Your code on GitHub** with full version history + rollback, plus a timestamped prompt log at `.yield/prompts.txt`.
- **Auto bug-fixer, select-to-edit, export as .zip, share links.**

---

## The `window.YIELD` runtime (injected into every generated app)

Generated apps run in a sandboxed iframe with a small runtime injected. This is what the coder builds against (full reference is served at **`GET /api/docs`** and lives in [`src/lib/platformGuide.ts`](src/lib/platformGuide.ts)):

| API | Purpose |
|-----|----------|
| `window.YIELD.entities.{list,create,get,update,delete}(entity, …)` | Free built-in database (records persist to GitHub / D1) |
| `window.YIELD.agents["Name"]` → `POST /api/agents/<id>/run` | Call an AI agent the coder created |
| `window.YIELD.secrets.NAME` | Owner-provided API keys/secrets (requested via `=== secret: … ===`) |
| `await window.YIELD.image(prompt)` | AI image generation (FLUX), returns an image URL |

The coder also uses build-time directives in its output: `=== file: path ===` (a file), `=== agent: Name | model ===` (a runtime agent), `=== secret: NAME — why ===` (request a secret), `=== research: Name ===` (a helper AI to plan first), `=== task: Name ===` (parallel build agent).

---

## The AIs — each is its own API

Configured in [`src/config/models.ts`](src/config/models.ts). **Every AI is wired as its own API:** it has its
own key env var (and can have its own base URL), resolved per-request. Unset keys fall back to `NVIDIA_API_KEY`,
so you can start with one key and split them out later with no code changes. **Verify each `modelId` at
https://build.nvidia.com** (a few versions are ahead of the public catalog, so they're swappable placeholders —
if a model id is off, calls automatically fall back to a working model).

| Role | Yield name | `modelId` (edit to match catalog) | Its API key (env var) |
|------|------------|------------------------------------|------------------------|
| Coder | Kimi K2.6 | `moonshotai/kimi-k2.6` | `KIMI_API_KEY` |
| Coder | MiniMax M3 | `minimaxai/minimax-m3` | `MINIMAX_API_KEY` |
| Coder | DeepSeek V4 Flash | `deepseek-ai/deepseek-v4-flash` | `DEEPSEEK_FLASH_API_KEY` |
| Coder | Step 3.7 Flash | `stepfun-ai/step-3.7-flash` | `STEP_API_KEY` |
| Coder | DeepSeek V4 Pro | `deepseek-ai/deepseek-v4-pro` | `DEEPSEEK_PRO_API_KEY` |
| Coder | GLM 5.1 | `z-ai/glm-5.1` | `GLM_API_KEY` |
| Coder | Qwen3 Coder 480B A35B (free) | `qwen/qwen3-coder:free` *(OpenRouter)* | `OPENROUTER_API_KEY` |
| Coder | Gemma 4 31B | `google/gemma-4-31b-it` | `GEMMA_API_KEY` / `NVIDIA_API_KEY` |
| Coder | Laguna M.1 (free) | `poolside/laguna-m.1:free` *(OpenRouter)* | `OPENROUTER_API_KEY` |
| Coder | Nemotron 3 Ultra 550B | `nvidia/nemotron-3-ultra-550b-a55b` | `NEMOTRON_API_KEY` / `NVIDIA_API_KEY` |
| Auto router | gpt-oss-20b | `openai/gpt-oss-20b` | `GPTOSS_API_KEY` |
| Jailbreak guard | JailbreakDetect | `nvidia/nemoguard-jailbreak-detect` | `NEMOGUARD_API_KEY` |

> Calls run with no `max_tokens` cap (no truncation) and a user-selected reasoning effort. To run an AI on a
> *different provider*, set `provider.baseUrl` for it in `src/config/models.ts`.

---

## ☑️ Keys / accounts you need to create

Put keys in `wrangler secret put …` (production) or `.dev.vars` (local). See `.dev.vars.example`.

| # | Service | What to create | Secret(s) to set |
|---|---------|----------------|------------------|
| 1 | **NVIDIA NIM** | One free developer key powers all the AIs + image gen | `NVIDIA_API_KEY` (`nvapi-…`) — https://build.nvidia.com |
| 2 | **Per-AI keys** *(optional)* | Separate key per AI for isolated quotas | `KIMI_API_KEY`, `MINIMAX_API_KEY`, `DEEPSEEK_FLASH_API_KEY`, `STEP_API_KEY`, `DEEPSEEK_PRO_API_KEY`, `GLM_API_KEY`, `GPTOSS_API_KEY`, `NEMOGUARD_API_KEY`, `OPENROUTER_API_KEY`, `GEMMA_API_KEY`, `NEMOTRON_API_KEY` |
| 3 | **GitHub OAuth App** | Login + code storage. Callback: `…/api/auth/github/callback` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| 4 | **Google OAuth Client** *(optional)* | Login. Redirect: `…/api/auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| 5 | **Stripe** *(optional)* | A $20/mo recurring Price + a webhook to `…/api/billing/webhook` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` (var) |
| 6 | **Session secret** | Random string for cookies / encrypting GitHub tokens | `SESSION_SECRET` (`openssl rand -hex 32`) |

Non-secret vars in `wrangler.toml [vars]`: `APP_URL`, `IMAGE_API_URL` (preset for FLUX), `DONATE_URL`
(optional — a Ko-fi/Stripe Payment Link/etc.; shows "Support Yield" buttons when set), `AUTH_ENABLED`,
and the High-Usage tuning knobs.

Cloudflare resources you create (IDs go into `wrangler.toml`): a **D1 database** (`npm run db:create`),
a **KV namespace** (`npm run kv:create`), and a **Durable Object** (the `BuildSession` binding + `v1`
migration are already declared — free on the Workers Free plan).

---

## 🔌 The HTTP API

Full reference in [`docs/API.md`](docs/API.md). Highlights:

### AI / generation
- `POST /api/generate` — **prompt → app**, streamed as SSE. Body: `{ prompt, model?, projectId?, thinking? }` (`thinking` = `low`|`medium`|`high`). Runs in a Durable Object so it survives a tab close/refresh.
- `GET  /api/projects/:id/stream` — reconnect a refreshed tab to an in-progress build (SSE).
- `POST /api/route` — auto-pick the best coder model (gpt-oss-20b).
- `GET  /api/models` — pickable models (+ Auto). · `GET /api/docs` — the coder's platform reference.

### Apps' runtime
- `POST /api/agents/:id/run` — run an AI agent (CORS-enabled; called from generated apps).
- `GET/POST/PUT/DELETE /api/apps/:id/entities/:entity[/:recordId]` — the built-in database.
- `POST /api/media/image` — AI image generation (FLUX).

### Projects, files, history
- `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:id`
- `GET/PUT/DELETE /api/projects/:id/files` — multi-file CRUD · `GET /api/projects/:id/export` — .zip
- `GET/POST /api/projects/:id/versions` — version history + rollback (GitHub commits)
- `GET /api/projects/:id/prompts` — timestamped prompt history (mirrored to `.yield/prompts.txt`)
- `GET /p/:id/<path>` — public sandboxed preview

### Account
- Auth: `…/api/auth/:provider/login|callback`, `/api/auth/logout`, email signup/login.
- `…/api/github/*`, `…/api/agents`, `…/api/secrets`, `…/api/billing/*`, `/api/status`, `/api/health`.

---

## 🚀 Setup & deploy

```bash
npm install

npm run db:create        # -> paste database_id into wrangler.toml
npm run kv:create        # -> paste id into wrangler.toml
npm run db:init          # apply schema (or db:init:local)

wrangler secret put NVIDIA_API_KEY
wrangler secret put SESSION_SECRET
# + GitHub/Google/Stripe secrets if you enable those features

npm run dev              # local
npm run deploy           # production
```

> **Deploy note:** Yield uses a **Durable Object migration**, which can only be applied by a full
> `wrangler deploy` — **not** `wrangler versions upload`. If you deploy via the Cloudflare Git
> integration, set the build's **Deploy command** to `npx wrangler deploy`. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

Local dev: copy `.dev.vars.example` → `.dev.vars` and fill it in.

---

## 💸 "High Usage Times" — the cost guard

**Yield stays free** and **you never get a surprise bill.** A monthly KV counter tracks generations; when it
exceeds `FREE_REQUEST_BUDGET` (set under your free hosting allowance), free + anonymous users pause until next
month while **Priority** ($20/mo) keeps going. Manual control without a redeploy: KV key `flag:high_usage`
(`on`/`off`) or the `HIGH_USAGE_OVERRIDE` var (`on`/`off`/`auto`). Free users also get `FREE_DAILY_LIMIT`;
anonymous trials get `ANON_DAILY_LIMIT`. Tune in `wrangler.toml [vars]`.

---

## 🔐 Auth (toggleable)

Gated behind one switch — `AUTH_ENABLED` in `wrangler.toml [vars]`:

- **`"false"` (testing mode):** no login required; everyone acts as a shared **guest**, limits off.
- **`"true"`:** accounts required — email + password (zero extra setup) and optional GitHub/Google OAuth
  (auto-hidden in the UI until you add each Client ID + secret).

Passwords are hashed with PBKDF2-SHA256; GitHub tokens are AES-GCM encrypted at rest (key from `SESSION_SECRET`).

## 🛡️ Safety

- Every prompt is screened by an automatic jailbreak guard (plus a local prefilter); blocked prompts never reach the coder.
- Generated apps render in a **sandboxed, opaque-origin iframe** — they can't touch Yield, your cookies, or your account.
- GitHub tokens and app secrets are **encrypted at rest**.

## Architecture

```
public/          static frontend (landing, builder, dashboard, account, pricing, donate, legal)
src/index.ts     Worker entry + router (exports the BuildSession Durable Object)
src/durable/     BuildSession — runs each build in the background, survives tab close/refresh
src/config/      model registry
src/lib/         nvidia, jailbreak, auth, db (D1), usage gate, billing, github, appdata,
                 prompts (coder/sub-agent/research/router), platformGuide (/api/docs),
                 verify (post-build static check + auto-repair), promptlog
src/routes/      generate, projects, agents, secrets, appdata, media, auth, billing, github, misc
schema.sql       D1 schema
```

---

## 📄 License

Yield is licensed under the MIT License — see [LICENSE](./LICENSE) file for details.

**Copyright © 2026 Penusila Digital Solutions LLC**

You are free to:
- ✅ Use Yield for personal or commercial projects
- ✅ Modify and distribute Yield
- ✅ Run your own hosted version
- ✅ Fork and customize for your needs

The only requirement: include the original license and copyright notice.

For more details, see the [MIT License](./LICENSE) file.
