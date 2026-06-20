// Sessions + OAuth (GitHub & Google).
//
// Sessions: a signed cookie holds `userId.expiry.signature`. The session record
// also lives in KV (so we can revoke). Anonymous visitors get a signed device id
// cookie for rate-limiting.

import type { Env, SessionUser } from '../types';
import { cookie, hmac, newId, now, parseCookies, safeEqual } from './response';
import { getUser } from './db';

const SESSION_COOKIE = 'yield_session';
const DEVICE_COOKIE = 'yield_device';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

// --- Session create / read / destroy -----------------------------------------
export async function createSession(env: Env, userId: string): Promise<string> {
  const sid = newId();
  const expiry = now() + SESSION_TTL;
  await env.KV.put(`sess:${sid}`, JSON.stringify({ userId, expiry }), { expirationTtl: SESSION_TTL });
  const sig = await hmac(env.SESSION_SECRET, `${sid}.${expiry}`);
  const value = `${sid}.${expiry}.${sig}`;
  return cookie(SESSION_COOKIE, value, { maxAge: SESSION_TTL, httpOnly: true });
}

export async function readSession(env: Env, req: Request): Promise<SessionUser | null> {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const [sid, expiryStr, sig] = raw.split('.');
  if (!sid || !expiryStr || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, `${sid}.${expiryStr}`);
  if (!safeEqual(sig, expected)) return null;
  if (Number(expiryStr) < now()) return null;
  const stored = await env.KV.get(`sess:${sid}`);
  if (!stored) return null;
  const { userId } = JSON.parse(stored) as { userId: string };
  const user = await getUser(env, userId);
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, plan: user.plan };
}

export async function destroySession(env: Env, req: Request): Promise<string> {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (raw) {
    const sid = raw.split('.')[0];
    if (sid) await env.KV.delete(`sess:${sid}`);
  }
  return cookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true });
}

// --- Anonymous device id (for rate limiting) ----------------------------------
export async function getOrCreateDeviceId(env: Env, req: Request): Promise<{ deviceId: string; setCookie?: string }> {
  const raw = parseCookies(req)[DEVICE_COOKIE];
  if (raw) {
    const [id, sig] = raw.split('.');
    if (id && sig && safeEqual(sig, await hmac(env.SESSION_SECRET, id))) return { deviceId: id };
  }
  const id = newId();
  const sig = await hmac(env.SESSION_SECRET, id);
  return { deviceId: id, setCookie: cookie(DEVICE_COOKIE, `${id}.${sig}`, { maxAge: 60 * 60 * 24 * 365, httpOnly: true }) };
}

// --- OAuth state (CSRF) -------------------------------------------------------
export interface OAuthState {
  provider: string;
  redirectTo: string;
  scope?: string; // overrides the default scope (e.g. 'repo' for code storage)
  storeToken?: boolean; // persist the provider access token (GitHub code sync)
}

export async function makeOAuthState(env: Env, s: OAuthState): Promise<string> {
  const state = newId();
  await env.KV.put(`oauth_state:${state}`, JSON.stringify(s), { expirationTtl: 600 });
  return state;
}

export async function takeOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  const key = `oauth_state:${state}`;
  const val = await env.KV.get(key);
  if (!val) return null;
  await env.KV.delete(key);
  return JSON.parse(val);
}

// --- Provider endpoints + profile normalization -------------------------------
export const PROVIDERS = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    clientId: (e: Env) => e.GITHUB_CLIENT_ID,
    clientSecret: (e: Env) => e.GITHUB_CLIENT_SECRET,
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientId: (e: Env) => e.GOOGLE_CLIENT_ID,
    clientSecret: (e: Env) => e.GOOGLE_CLIENT_SECRET,
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

// Which login methods are usable, based on whether OAuth creds are real (not
// placeholders). Lets the UI hide buttons that aren't configured yet.
export function enabledProviders(env: Env): { email: boolean; github: boolean; google: boolean } {
  const ok = (v?: string) => !!v && !/placeholder/i.test(v) && !/^replace/i.test(v);
  return {
    email: true,
    github: ok(env.GITHUB_CLIENT_ID) && ok(env.GITHUB_CLIENT_SECRET),
    google: ok(env.GOOGLE_CLIENT_ID) && ok(env.GOOGLE_CLIENT_SECRET),
  };
}

export async function fetchGithubProfile(token: string) {
  const headers = { authorization: `Bearer ${token}`, 'user-agent': 'Yield', accept: 'application/json' };
  const [u, emails] = await Promise.all([
    fetch('https://api.github.com/user', { headers }).then((r) => r.json() as any),
    fetch('https://api.github.com/user/emails', { headers }).then((r) => (r.ok ? (r.json() as any) : [])),
  ]);
  const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary)?.email : null;
  return {
    provider_id: String(u.id),
    email: primary || u.email || null,
    name: u.name || u.login || null,
    avatar_url: u.avatar_url || null,
    login: u.login || null,
  };
}

export async function fetchGoogleProfile(token: string) {
  const u: any = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  return {
    provider_id: String(u.sub),
    email: u.email || null,
    name: u.name || null,
    avatar_url: u.picture || null,
  };
}
