// "High Usage Times" gating + per-user rate limits.
//
// The whole point: Yield is free until Cloudflare usage threatens to cost money.
// At that point we flip into HIGH USAGE MODE, where only paid ($20/mo "Priority")
// users may generate. Everyone else sees a friendly "high usage right now" notice
// and an upgrade option.
//
// Fast counters live in KV (cheap, eventually-consistent is fine here):
//   usage:month:<YYYY-MM>            -> total generations this month (budget meter)
//   usage:user:<id>:<YYYY-MM-DD>     -> per-user generations today
//   usage:dev:<deviceId>:<YYYY-MM-DD>-> per-anon-device generations today
// A manual kill-switch lives in KV at flag:high_usage = 'on' | 'off' (or unset=auto),
// and HIGH_USAGE_OVERRIDE var can force it globally without a deploy.

import type { Ctx, Env } from '../types';

function ym(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

async function readInt(env: Env, key: string): Promise<number> {
  try {
    const v = await env.KV.get(key);
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0; // don't let a KV hiccup 500 the request
  }
}

// KV has no atomic increment; for a budget meter, last-writer-wins is fine. Never
// throws — a failed counter just means a slightly-late High Usage Time trip.
async function bump(env: Env, key: string, ttlSeconds: number): Promise<number> {
  const next = (await readInt(env, key)) + 1;
  await env.KV.put(key, String(next), { expirationTtl: ttlSeconds }).catch(() => {});
  return next;
}

export interface UsageState {
  highUsage: boolean;
  monthlyCount: number;
  budget: number;
  source: 'override-on' | 'override-off' | 'flag-on' | 'flag-off' | 'budget' | 'auto';
}

/** Is the app currently in high-usage (paid-only) mode? */
export async function getUsageState(env: Env): Promise<UsageState> {
  const budget = parseInt(env.FREE_REQUEST_BUDGET, 10) || 2_500_000;
  const monthlyCount = await readInt(env, `usage:month:${ym()}`);

  // 1) Hard global override from env var.
  const override = (env.HIGH_USAGE_OVERRIDE || 'auto').toLowerCase();
  if (override === 'on') return { highUsage: true, monthlyCount, budget, source: 'override-on' };
  if (override === 'off') return { highUsage: false, monthlyCount, budget, source: 'override-off' };

  // 2) Runtime kill-switch in KV (you can flip this without redeploying).
  const flag = await env.KV.get('flag:high_usage').catch(() => null);
  if (flag === 'on') return { highUsage: true, monthlyCount, budget, source: 'flag-on' };
  if (flag === 'off') return { highUsage: false, monthlyCount, budget, source: 'flag-off' };

  // 3) Automatic: trip when the monthly free budget is exhausted.
  return { highUsage: monthlyCount >= budget, monthlyCount, budget, source: monthlyCount >= budget ? 'budget' : 'auto' };
}

export interface GateResult {
  allowed: boolean;
  status: number;
  reason?: string;
  code?: 'high_usage' | 'daily_limit' | 'login_required';
  usage: UsageState;
}

/**
 * Decide whether THIS request may run a generation. Builds are UNLIMITED in normal
 * times — no per-user, per-device, or daily caps (projects live in the user's own
 * GitHub, so volume doesn't cost us storage). The ONE exception is HIGH USAGE TIME:
 * when monthly volume crosses FREE_REQUEST_BUDGET (i.e. usage starts to threaten
 * Cloudflare cost) — or a manual kill-switch is flipped — free + anonymous generation
 * is paused and only Priority ($20/mo) members can build. That is the whole point of
 * Priority: it funds and stays available during the busy/costly periods.
 */
export async function gateGeneration(c: Ctx): Promise<GateResult> {
  const usage = await getUsageState(c.env);
  if (c.env.AUTH_ENABLED === 'false') return { allowed: true, status: 200, usage }; // open testing: no gating
  if (c.user?.plan === 'priority') return { allowed: true, status: 200, usage };     // Priority always allowed
  if (usage.highUsage) {
    return {
      allowed: false,
      status: 402,
      code: 'high_usage',
      reason:
        "It's High Usage Time right now — Yield is near its free hosting budget, so generation is " +
        "paused for free accounts to keep the app free to run. Priority members ($20/mo) keep full " +
        "access and fund these busy periods. Try again later, or upgrade.",
      usage,
    };
  }
  return { allowed: true, status: 200, usage }; // otherwise: unlimited
}

/** Count toward the monthly budget meter that trips High Usage Time when usage nears
 *  Cloudflare's free ceiling. No per-user/daily counters — builds are unlimited. Only
 *  meaningful when accounts are on (open testing mode never gates, so skip the write). */
export async function recordGeneration(c: Ctx): Promise<void> {
  if (c.env.AUTH_ENABLED === 'false') return;
  await bump(c.env, `usage:month:${ym()}`, 60 * 60 * 24 * 32);
}

/** Public snapshot for the status endpoint / UI banner. */
export async function usageSnapshot(c: Ctx) {
  const usage = await getUsageState(c.env);
  return {
    highUsage: usage.highUsage,
    plan: c.user?.plan ?? 'anonymous',
    remainingToday: null,                // no daily limit — unlimited until High Usage Time
    unlimited: !usage.highUsage,
    monthlyUsedPct: Math.min(100, Math.round((usage.monthlyCount / usage.budget) * 100)),
  };
}
