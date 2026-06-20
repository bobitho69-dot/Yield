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

function ymd(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function ym(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

async function readInt(env: Env, key: string): Promise<number> {
  const v = await env.KV.get(key);
  return v ? parseInt(v, 10) || 0 : 0;
}

// KV has no atomic increment; for a budget meter, last-writer-wins is acceptable.
async function bump(env: Env, key: string, ttlSeconds: number): Promise<number> {
  const next = (await readInt(env, key)) + 1;
  await env.KV.put(key, String(next), { expirationTtl: ttlSeconds });
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
  const flag = await env.KV.get('flag:high_usage');
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

/** Decide whether THIS request may run a generation. Does not yet record usage. */
export async function gateGeneration(c: Ctx): Promise<GateResult> {
  const usage = await getUsageState(c.env);

  // Open testing mode: no gating at all.
  if (c.env.AUTH_ENABLED === 'false') return { allowed: true, status: 200, usage };

  const isPaid = c.user?.plan === 'priority';

  // Paid users are always allowed (that's the deal: they fund the high-usage time).
  if (isPaid) return { allowed: true, status: 200, usage };

  // During high-usage mode, free + anonymous are paused.
  if (usage.highUsage) {
    return {
      allowed: false,
      status: 402,
      code: 'high_usage',
      reason:
        "It's High Usage Time right now — Yield hit its free hosting budget for the month, so generation is paused for free accounts to keep the app free to run. Priority members ($20/mo) keep full access and fund these busy periods. Try again later, or upgrade.",
      usage,
    };
  }

  // Per-user / per-device daily limits keep the free tier sustainable.
  if (c.user) {
    const limit = parseInt(c.env.FREE_DAILY_LIMIT, 10) || 15;
    const used = await readInt(c.env, `usage:user:${c.user.id}:${ymd()}`);
    if (used >= limit) {
      return {
        allowed: false,
        status: 429,
        code: 'daily_limit',
        reason: `You've used your ${limit} free generations for today. Resets at midnight UTC — or upgrade to Priority for unlimited.`,
        usage,
      };
    }
  } else {
    const limit = parseInt(c.env.ANON_DAILY_LIMIT, 10) || 3;
    const used = await readInt(c.env, `usage:dev:${c.deviceId}:${ymd()}`);
    if (used >= limit) {
      return {
        allowed: false,
        status: 401,
        code: 'login_required',
        reason: `You've used your ${limit} free trial generations. Sign in (free) for more.`,
        usage,
      };
    }
  }

  return { allowed: true, status: 200, usage };
}

/** Record a successful generation against monthly budget + daily quotas. */
export async function recordGeneration(c: Ctx): Promise<void> {
  const DAY = 60 * 60 * 26;
  const MONTH = 60 * 60 * 24 * 32;
  await bump(c.env, `usage:month:${ym()}`, MONTH);
  if (c.user) await bump(c.env, `usage:user:${c.user.id}:${ymd()}`, DAY);
  else await bump(c.env, `usage:dev:${c.deviceId}:${ymd()}`, DAY);
}

/** Public snapshot for the status endpoint / UI banner. */
export async function usageSnapshot(c: Ctx) {
  const usage = await getUsageState(c.env);
  let remainingToday: number | null = null;
  if (c.user?.plan !== 'priority') {
    if (c.user) {
      const limit = parseInt(c.env.FREE_DAILY_LIMIT, 10) || 15;
      remainingToday = Math.max(0, limit - (await readInt(c.env, `usage:user:${c.user.id}:${ymd()}`)));
    } else {
      const limit = parseInt(c.env.ANON_DAILY_LIMIT, 10) || 3;
      remainingToday = Math.max(0, limit - (await readInt(c.env, `usage:dev:${c.deviceId}:${ymd()}`)));
    }
  }
  return {
    highUsage: usage.highUsage,
    plan: c.user?.plan ?? 'anonymous',
    remainingToday,
    monthlyUsedPct: Math.min(100, Math.round((usage.monthlyCount / usage.budget) * 100)),
  };
}
