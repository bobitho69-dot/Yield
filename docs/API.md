# Yield API reference

Base URL is your Worker origin. JSON responses are `application/json` with `Cache-Control: no-store`.
Auth is a signed `yield_session` cookie (set after login). Anonymous callers get a `yield_device`
cookie for trial rate-limiting. When `AUTH_ENABLED="false"` every request acts as a shared **guest**.

Conventions:
- 🔓 = works anonymously/guest · 🔐 = requires sign-in · 💳 = behaves differently for Priority users
- Errors: `{ "error": "message", "code"?: "machine_code", ... }`

---

## Upstream AIs (each model is its own API)

OpenAI-compatible chat endpoints (except the guard, a classify endpoint). Default base URL is
`NVIDIA_CHAT_BASE`; each AI uses its own key env var, falling back to `NVIDIA_API_KEY`. Calls send **no
`max_tokens` cap** and a per-request reasoning effort. If a `modelId` is unavailable, the caller falls
back to a working model. Configured in `src/config/models.ts`.

| Yield name | Role | `modelId` | Key env var |
|------------|------|-----------|-------------|
| Kimi K2.6 | coder | `moonshotai/kimi-k2.6` | `KIMI_API_KEY` |
| MiniMax M3 | coder | `minimaxai/minimax-m3` | `MINIMAX_API_KEY` |
| DeepSeek V4 Flash | coder | `deepseek-ai/deepseek-v4-flash` | `DEEPSEEK_FLASH_API_KEY` |
| Step 3.7 Flash | coder | `stepfun-ai/step-3.7-flash` | `STEP_API_KEY` |
| DeepSeek V4 Pro | coder | `deepseek-ai/deepseek-v4-pro` | `DEEPSEEK_PRO_API_KEY` |
| GLM 5.1 | coder | `z-ai/glm-5.1` | `GLM_API_KEY` |
| Qwen3 Coder 480B (free) | coder | `qwen/qwen3-coder:free` *(OpenRouter)* | `OPENROUTER_API_KEY` |
| Gemma 4 31B (free) | coder | `google/gemma-4-31b-it:free` *(OpenRouter)* | `OPENROUTER_API_KEY` |
| gpt-oss-20b | router (Auto) + agent fallback | `openai/gpt-oss-20b` | `GPTOSS_API_KEY` |
| JailbreakDetect | guard | `nvidia/nemoguard-jailbreak-detect` | `NEMOGUARD_API_KEY` |

---

## AI / generation

### `POST /api/generate` 🔓💳  — the core endpoint
Body: `{ "prompt": string, "model"?: "auto"|"<model id>", "projectId"?: string, "thinking"?: "low"|"medium"|"high" }`

Pipeline: jailbreak check → usage gate → resolve model (Auto routes via gpt-oss-20b) → the build runs in a
**`BuildSession` Durable Object** (so it survives the tab closing/refreshing) → optional research helpers →
stream files → optional parallel build agents → save (D1 + GitHub) → record usage.

**Success** is a `text/event-stream` (SSE). The response is the DO's live stream; the same stream can be
re-attached via `GET /api/projects/:id/stream`.

| event | data | meaning |
|-------|------|---------|
| `status` | `{ stage }` | progress label (screening, routing, writing a file, launching agents…) |
| `meta` | `{ model, label, projectId, routeReason }` | chosen model + (new) project id |
| `thinking` | `"<reasoning chunk>"` | model reasoning (Thinking panel) |
| `research` | `{ name, status?, findings? }` | a helper AI's progress/findings |
| `code` | `{ agent, path, delta }` | a file being written live (tagged by which AI) |
| `chat` | `"<text chunk>"` | the assistant's conversational reply |
| `done` | `{ chat, files:[{path,content}], hasCode, projectId, secretsNeeded, agents }` | final result |
| `blocked` | `{ message, detail }` | prompt blocked by the jailbreak guard |
| `gate` | `{ message, code }` | paused (high usage / login required) |
| `error` | `{ message }` | failure |
| `end` | `{}` | the build is over (DO sentinel) |

### `GET /api/projects/:id/stream` 🔓(owner)
Re-attach a refreshed/reopened tab to an in-progress build. Replays buffered events, then streams live; emits `end` immediately if the build already finished.

### `POST /api/route` 🔓
Body: `{ "prompt": string }` → `{ model, reason, label, tier, pros, cons }` (gpt-oss-20b pick).

### `GET /api/models` 🔓
→ `{ models: [{ id, label, blurb, tier, speed, pros, cons }] }` (includes `auto`).

### `GET /api/docs` 🔓
→ the coder's full platform reference (markdown) — the same guide injected into the build context.

---

## Apps' runtime (called from generated apps; CORS-enabled)

### `POST /api/agents/:id/run` 🔓
Body: `{ "input"?: string, "messages"?: [{role,content}] }` → `{ output, agent, model }`.
Tries the agent's model, then stable fallbacks, ending with gpt-oss; no token cap.

### `/api/apps/:id/entities/:entity[/:recordId]` 🔓 — the built-in database
- `GET /api/apps/:id/entities/:entity` → `{ records: [...] }`
- `POST …/:entity` `{...}` → `{ record }` · `GET …/:entity/:recordId` → `{ record }`
- `PUT …/:entity/:recordId` `{...}` → `{ record }` · `DELETE …/:entity/:recordId` → `{ ok }`

Records get auto `id`, `created_at`, `updated_at`; stored in the project's GitHub repo (`.yield/data/<entity>.json`) or D1.

### `POST /api/media/image` 🔓
Body: `{ "prompt": string, …opts }` → `{ url, raw }` (FLUX image generation).

---

## Projects, files, history

### `GET /api/projects` 🔐 · `POST /api/projects` 🔐
List / create. Create body: `{ "title"?: string }`.

### `GET /api/projects/:id` 🔐
→ `{ project, messages: [{role,content,model,flagged,created_at}], building: boolean }`

### `PUT /api/projects/:id` 🔐  `{ "title"?: string }` — rename. · `DELETE /api/projects/:id` 🔐

### `GET/PUT/DELETE /api/projects/:id/files` 🔐 — multi-file CRUD
- `GET` → `{ files: [{path, content}] }`
- `PUT` `{ path, content }` — upsert a file (auto-syncs to GitHub)
- `DELETE ?path=` — remove a file

### `GET /api/projects/:id/export` 🔐 → the whole app as a `.zip` download.

### `GET/POST /api/projects/:id/versions` 🔐 — version history (GitHub commits)
- `GET` → `{ commits: [{ sha, message, … }] }`
- `POST` `{ sha }` — restore the app to that version (creates a new commit).

### `GET /api/projects/:id/prompts` 🔐
→ `{ entries: [{ time, role, content, model, flagged }], text }` — timestamped chat history (also mirrored to the repo at `.yield/prompts.txt`).

### `GET /p/:id/<path>` 🔓(owner or public)
Sandboxed project file for the preview iframe / public sharing. HTML responses inject the `window.YIELD` runtime and carry a strict `Content-Security-Policy: sandbox …` header. Accepts a project id or a readable slug.

---

## Agents & secrets (management)

### `/api/agents` 🔐
- `GET /api/agents?project=:id` → `{ agents }` · `POST /api/agents` `{ name, description?, system_prompt, model?, is_public? }` → `{ agent }`
- `GET/PUT/DELETE /api/agents/:id`

### `/api/secrets` 🔐
- `GET /api/secrets?project=:id` → `{ secrets: [{ id, name }] }` (values never returned)
- `POST /api/secrets?project=:id` `{ name, value }` (encrypted at rest) · `DELETE /api/secrets/:id`

---

## GitHub code storage

### `GET /api/github/status` 🔓 → `{ connected, login }`
### `GET /api/github/repos` 🔐 → `{ repos: [{ full_name, html_url, default_branch, private }] }`
### `POST /api/projects/:id/github` 🔐
`{ "action": "create" | "link" | "push" | "unlink", … }` → `{ ok, github_repo?, github_url? }`. Code also auto-pushes after every build and manual save once linked.

---

## Billing — $20/mo Priority Access

- `POST /api/billing/checkout` 🔐 → `{ url }` (Stripe Checkout)
- `POST /api/billing/portal` 🔐 → `{ url }` (manage/cancel)
- `POST /api/billing/webhook` 🔓 (Stripe-signed) → `{ received: true }`
- `GET /api/billing/status` 🔓 → `{ plan, renews_at? }`

---

## System

### `GET /api/status` 🔓
→ `{ app, user, authEnabled, providers, donateUrl, highUsage, plan, remainingToday, … }` — drives the builder banner, quota, donate links.

### `GET /api/health` 🔓 → `{ ok, db, kv }` (checks the D1 + KV bindings).
