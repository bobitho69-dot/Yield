# Deploy Yield via GitHub → Cloudflare

Two ways to ship. **Option A (recommended)** uses Cloudflare's native Git integration —
connect the repo once and every push auto-builds + deploys, no CI file needed.
**Option B** is a GitHub Actions workflow if you'd rather drive it from GitHub.

Either way you do these **one-time prerequisites** first.

---

## 0. One-time prerequisites

### a) Create the D1 database + KV namespace
Cloudflare dashboard → **Storage & Databases**:
- **D1** → *Create* → name it `yield-db` → copy the **Database ID**.
- **KV** → *Create namespace* → name it `KV` → copy the **Namespace ID**.

Paste both IDs into `wrangler.toml` (replace the `PLACEHOLDER_…` values) and commit:
```toml
[[d1_databases]]
binding = "DB"
database_name = "yield-db"
database_id = "<your D1 id>"

[[kv_namespaces]]
binding = "KV"
id = "<your KV id>"
```

### b) Load the database schema (once)
Easiest from the D1 page: open `yield-db` → **Console**, paste the contents of
[`schema.sql`](../schema.sql), run. (Or locally: `npm run db:init`.)

### c) Add your secrets
Cloudflare dashboard → your Worker → **Settings → Variables and Secrets** → add each as an
**encrypted secret**:

```
NVIDIA_API_KEY            (shared key; every AI falls back to this)
SESSION_SECRET            (openssl rand -hex 32)
GITHUB_CLIENT_ID  GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET
STRIPE_SECRET_KEY  STRIPE_WEBHOOK_SECRET
```
Optional per-AI keys (only if you want separate keys per AI):
`KIMI_API_KEY`, `MINIMAX_API_KEY`, `DEEPSEEK_FLASH_API_KEY`, `STEP_API_KEY`,
`DEEPSEEK_PRO_API_KEY`, `GLM_API_KEY`, `GPTOSS_API_KEY`, `NEMOGUARD_API_KEY`.

Also set `APP_URL` (under plain Variables) to your Worker's URL once you know it, and
`STRIPE_PRICE_ID` to your $20/mo price id.

---

## Option A — Connect to Git (recommended)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**.
2. Authorize GitHub and pick this repo + the branch you want to deploy
   (e.g. `main`, or `claude/elegant-dirac-wq2beg`).
3. Cloudflare reads `wrangler.toml` automatically. Leave the defaults:
   - Build/deploy command: `npx wrangler deploy`
   - Cloudflare runs `npm install` for you.
4. Click **Deploy**. From now on, **every push to that branch auto-deploys.**
5. After the first deploy, copy the `*.workers.dev` URL into the `APP_URL` variable and into
   your GitHub/Google OAuth callback URLs and Stripe webhook URL.

> Make sure the branch you connect is the one that has the code. To deploy from `main`,
> open a PR from `claude/elegant-dirac-wq2beg` → `main` and merge.

---

## Option B — GitHub Actions

This repo includes [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).
Add two **GitHub repo secrets** (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — create at Cloudflare → My Profile → API Tokens →
  *Edit Cloudflare Workers* template.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers & Pages (right sidebar).

Push to `main` and the workflow runs `wrangler deploy`. (Worker **secrets** are still set
once in the Cloudflare dashboard as in step 0c — Actions only deploys the code.)

---

## After deploy — wire the callbacks
With your real URL (`https://yield.<you>.workers.dev` or a custom domain):
- **GitHub OAuth App** callback → `https://<url>/api/auth/github/callback`
- **Google OAuth** redirect → `https://<url>/api/auth/google/callback`
- **Stripe webhook** endpoint → `https://<url>/api/billing/webhook` (copy its signing secret
  into `STRIPE_WEBHOOK_SECRET`)
- Set `APP_URL` to `https://<url>`.

That's it — Yield is live and free, with High Usage Times protecting your bill.
