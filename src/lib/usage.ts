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
 * Decide whether THIS request may run a generation. Builds are UNLIMITED — there are
 * no per-user, per-device, daily, or budget caps (projects live in the user's own
 * GitHub, so volume doesn't cost us storage). The ONLY thing that can pause generation
 * is a MANUAL emergency kill-switch — HIGH_USAGE_OVERRIDE='on' or the KV flag
 * flag:high_usage='on' — and even then Priority members and open testing mode are
 * never paused. Automatic budget tripping (source 'budget') is ignored.
 */
export async function gateGeneration(c: Ctx): Promise<GateResult> {
  const usage = await getUsageState(c.env);
  const manualPause = usage.source === 'override-on' || usage.source === 'flag-on';
  if (manualPause && c.env.AUTH_ENABLED !== 'false' && c.user?.plan !== 'priority') {
    return {
      allowed: false,
      status: 402,
      code: 'high_usage',
      reason: 'Generation is temporarily paused — please try again shortly.',
      usage,
    };
  }
  return { allowed: true, status: 200, usage };
}

/** No-op: builds are unlimited, so there are no usage counters to maintain. (D1
 *  usage_events analytics are still written separately by logUsage.) */
export async function recordGeneration(_c: Ctx): Promise<void> {
  /* intentionally empty — no build limits */
}

/** Public snapshot for the status endpoint / UI banner. Builds are unlimited. */
export async function usageSnapshot(c: Ctx) {
  const usage = await getUsageState(c.env);
  return {
    highUsage: usage.highUsage, // true only via the manual kill-switch now
    plan: c.user?.plan ?? 'anonymous',
    remainingToday: null,       // unlimited
    unlimited: true,
    monthlyUsedPct: 0,
  };
}
