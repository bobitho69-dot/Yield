# Yield API reference

Base URL is your Worker origin. All JSON responses are `application/json` with `Cache-Control: no-store`.
Auth is a signed `yield_session` cookie (set after OAuth). Anonymous callers get a `yield_device`
cookie used for trial rate-limiting.

Conventions:
- 🔓 = works anonymously · 🔐 = requires sign-in · 💳 = behaves differently for Priority users
- Errors: `{ "error": "message", "code"?: "machine_code", ... }`

---

## Auth

### `GET /api/auth/:provider/login` 🔓
Start OAuth. `:provider` = `github` | `google`.
Query: `redirect` (path to return to), `scope` (e.g. `repo`), `store_token=1` (persist GitHub token for code storage).
→ 302 to the provider.

### `GET /api/auth/:provider/callback` 🔓
OAuth redirect target. Exchanges the code, upserts the user, creates a session, 302s back to `redirect`.

### `POST /api/auth/logout` 🔓
Clears the session cookie. → `{ ok: true }`

### `GET /api/auth/me` 🔓
→ `{ user: { id, email, name, avatar_url, plan } | null }`

---

## AI / generation

### `POST /api/generate` 🔓💳  — the core endpoint
Body: `{ "prompt": string, "model"?: "auto"|"<model id>", "projectId"?: string }`

Pipeline: NeMoGuard jailbreak check → usage gate → resolve model (Auto routes via gpt-oss-20b)
→ stream codegen → (signed-in) save code + history + GitHub sync → record usage.

**Success** is an `text/event-stream` (SSE) with events:
| event | data | meaning |
|-------|------|---------|
| `meta` | `{ model, label, projectId, routeReason }` | chosen model + (new) project id |
| `delta` | `"<text chunk>"` | streamed HTML as it's generated |
| `done` | `{ code, projectId }` | final cleaned HTML document |
| `error` | `{ message }` | mid-stream failure |

**Pre-stream errors** (JSON, not SSE):
- `451 { code: "jailbreak_blocked", detail, score }` — blocked by the guard
- `402 { code: "high_usage" }` — High Usage Time, free users paused
- `429 { code: "daily_limit" }` — free daily cap hit
- `401 { code: "login_required" }` — anonymous trial used up

### `POST /api/route` 🔓
Body: `{ "prompt": string }` → `{ "model": "<id>", "reason": string }` (gpt-oss-20b pick).

### `GET /api/models` 🔓
→ `{ models: [{ id, label, blurb, tier }] }` (includes `auto`).

---

## Projects

### `GET /api/projects` 🔐
→ `{ projects: [{ id, title, model, is_public, github_repo, github_url, has_code, updated_at, created_at }] }`

### `POST /api/projects` 🔐
Body: `{ "title"?: string }` → `{ project }` (201)

### `GET /api/projects/:id` 🔐
→ `{ project: {…, code, github_repo, github_url, github_branch}, messages: [{role, content, model, flagged, created_at}] }`

### `PUT /api/projects/:id` 🔐
Body: `{ "code"?: string, "title"?: string }` — save manual edits / rename. Auto-syncs to GitHub if linked.
→ `{ ok: true }`

### `DELETE /api/projects/:id` 🔐
→ `{ ok: true }`

### `GET /api/projects/:id/preview` 🔓(owner or public)
Returns the project's raw HTML with a strict `Content-Security-Policy: sandbox …` header.
Used as the `src` of the preview iframe.

### `GET /p/:id` 🔓
Public preview shortcut (only if the project is public).

---

## GitHub code storage

### `GET /api/github/status` 🔓
→ `{ connected: boolean, login: string|null }`

### `GET /api/github/repos` 🔐
→ `{ repos: [{ full_name, html_url, default_branch, private }] }` (your owned repos)

### `POST /api/projects/:id/github` 🔐
Body: `{ "action": "create" | "link" | "push" | "unlink", … }`
- `create`: `{ name?, private? }` → makes a new repo, pushes `index.html` + `README.md`
- `link`: `{ repo: "owner/name", branch? }` → links existing repo and pushes
- `push`: pushes current code to the linked repo
- `unlink`: removes the link
→ `{ ok: true, github_repo?, github_url? }`

> Generated code also auto-pushes after every build and manual save once a project is linked.

---

## Billing — $20/mo Priority Access

### `POST /api/billing/checkout` 🔐
→ `{ url }` — redirect the user to Stripe Checkout.

### `POST /api/billing/portal` 🔐
→ `{ url }` — Stripe billing portal (manage/cancel).

### `POST /api/billing/webhook` 🔓 (Stripe-signed)
Verifies `Stripe-Signature`, then handles `checkout.session.completed`,
`customer.subscription.created|updated|deleted` to flip the user's `plan`.
→ `{ received: true }`

### `GET /api/billing/status` 🔓
→ `{ plan: "free"|"priority"|"anonymous", renews_at?: number }`

---

## System

### `GET /api/status` 🔓
→ `{ app, user, highUsage, plan, remainingToday, monthlyUsedPct }` — drives the builder's banner + quota.

### `GET /api/health` 🔓
→ `{ ok: true }`
