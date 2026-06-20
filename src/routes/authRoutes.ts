// OAuth login/callback + session endpoints.
//   GET  /api/auth/:provider/login     -> redirect to provider
//   GET  /api/auth/:provider/callback  -> exchange code, create session
//   POST /api/auth/logout
//   GET  /api/auth/me

import type { Ctx } from '../types';
import { json, redirect, error } from '../lib/response';
import {
  PROVIDERS, ProviderName, createSession, destroySession, fetchGithubProfile, fetchGoogleProfile,
  makeOAuthState, takeOAuthState,
} from '../lib/auth';
import { setGithubAuth, upsertOAuthUser } from '../lib/db';
import { encryptToken } from '../lib/github';

export async function handleAuth(req: Request, c: Ctx, provider?: string, action?: string): Promise<Response> {
  if (provider === 'logout' || (req.method === 'POST' && c.url.pathname === '/api/auth/logout')) {
    const clear = await destroySession(c.env, req);
    return json({ ok: true }, { headers: { 'set-cookie': clear } });
  }

  if (provider === 'me') {
    return json({ user: c.user });
  }

  if (!provider || !(provider in PROVIDERS)) return error(404, 'Unknown provider');
  const p = PROVIDERS[provider as ProviderName];

  if (action === 'login') {
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
