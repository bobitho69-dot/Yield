// OAuth login/callback + session endpoints.
//   GET  /api/auth/:provider/login     -> redirect to provider
//   GET  /api/auth/:provider/callback  -> exchange code, create session
//   POST /api/auth/logout
//   GET  /api/auth/me

import type { Ctx } from '../types';
import { json, redirect, error } from '../lib/response';
import {
  PROVIDERS, ProviderName, createSession, destroySession, enabledProviders, fetchGithubProfile,
  fetchGoogleProfile, makeOAuthState, takeOAuthState,
} from '../lib/auth';
import { createEmailUser, getUserByEmail, setGithubAuth, upsertOAuthUser } from '../lib/db';
import { encryptToken } from '../lib/github';
import { hashPassword, verifyPassword, validateCredentials } from '../lib/password';

export async function handleAuth(req: Request, c: Ctx, provider?: string, action?: string): Promise<Response> {
  if (provider === 'logout' || (req.method === 'POST' && c.url.pathname === '/api/auth/logout')) {
    const clear = await destroySession(c.env, req);
    return json({ ok: true }, { headers: { 'set-cookie': clear } });
  }

  if (provider === 'me') {
    return json({ user: c.user });
  }

  // Which login methods are configured (email always; OAuth only if creds set).
  if (provider === 'providers') {
    return json({ providers: enabledProviders(c.env) });
  }

  // Email + password.
  if (provider === 'email') {
    if (action === 'signup') return emailSignup(req, c);
    if (action === 'login') return emailLogin(req, c);
    return error(404, 'Not found');
  }

  if (!provider || !(provider in PROVIDERS)) return error(404, 'Unknown provider');
  const p = PROVIDERS[provider as ProviderName];

  if (action === 'login') {
    // Don't start an OAuth flow that isn't configured yet.
    const prov = enabledProviders(c.env);
    if ((provider === 'github' && !prov.github) || (provider === 'google' && !prov.google)) {
      return error(503, `${provider} login isn’t configured yet. Use email + password.`, { code: 'provider_disabled' });
    }
    const redirectTo = c.url.searchParams.get('redirect') || '/app';
    // Optional elevated scope (e.g. ?scope=repo&store_token=1) to enable code storage.
    const scopeOverride = c.url.searchParams.get('scope') || undefined;
    const storeToken = c.url.searchParams.get('store_token') === '1';
    const scope = provider === 'github' && scopeOverride ? `${p.scope} ${scopeOverride}` : p.scope;
    const state = await makeOAuthState(c.env, { provider, redirectTo, scope: scopeOverride, storeToken });
    const params = new URLSearchParams({
      client_id: p.clientId(c.env),
      redirect_uri: `${c.env.APP_URL}/api/auth/${provider}/callback`,
      scope,
      state,
      response_type: 'code',
    });
    if (provider === 'google') params.set('access_type', 'online');
    return redirect(`${p.authUrl}?${params.toString()}`);
  }

  if (action === 'callback') {
    const code = c.url.searchParams.get('code');
    const state = c.url.searchParams.get('state');
    if (!code || !state) return error(400, 'Missing code/state');
    const saved = await takeOAuthState(c.env, state);
    if (!saved || saved.provider !== provider) return error(400, 'Invalid OAuth state');

    // Exchange code -> access token.
    const tokenRes = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: p.clientId(c.env),
        client_secret: p.clientSecret(c.env),
        code,
        redirect_uri: `${c.env.APP_URL}/api/auth/${provider}/callback`,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const token = (await tokenRes.json()) as any;
    const accessToken = token.access_token;
    if (!accessToken) return error(400, 'OAuth token exchange failed');

    const profile = provider === 'github' ? await fetchGithubProfile(accessToken) : await fetchGoogleProfile(accessToken);
    const user = await upsertOAuthUser(c.env, { provider, ...profile });

    // Persist the GitHub token (encrypted) when the user is connecting code storage.
    if (provider === 'github' && saved.storeToken && (profile as any).login) {
      const enc = await encryptToken(c.env, accessToken);
      await setGithubAuth(c.env, user.id, (profile as any).login, enc);
    }

    const setCookie = await createSession(c.env, user.id);
    return redirect(saved.redirectTo || '/app', { 'set-cookie': setCookie });
  }

  return error(404, 'Not found');
}

// POST /api/auth/email/signup  { email, password, name? }
async function emailSignup(req: Request, c: Ctx): Promise<Response> {
  const { email, password, name } = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
  const v = validateCredentials(email || '', password || '');
  if (v) return error(400, v);
  const existing = await getUserByEmail(c.env, email!);
  if (existing) return error(409, 'An account with that email already exists. Try signing in.');
  const password_hash = await hashPassword(password!);
  const user = await createEmailUser(c.env, { email: email!, name: name || email!.split('@')[0], password_hash });
  const setCookie = await createSession(c.env, user.id);
  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } },
    { headers: { 'set-cookie': setCookie } },
  );
}

// POST /api/auth/email/login  { email, password }
async function emailLogin(req: Request, c: Ctx): Promise<Response> {
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password) return error(400, 'Email and password are required.');
  const user = await getUserByEmail(c.env, email);
  // Same response whether the user exists or not (don't leak which emails are registered).
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return error(401, 'Invalid email or password.');
  }
  const setCookie = await createSession(c.env, user.id);
  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } },
    { headers: { 'set-cookie': setCookie } },
  );
}
