// Secrets — user config stored AES-GCM encrypted at rest (same handling as the
// GitHub token). Values are never returned to the client once set.
//   GET    /api/secrets        list names (no values)
//   POST   /api/secrets        upsert {name, value}
//   DELETE /api/secrets/:id    remove

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import { deleteSecret, listSecrets, upsertSecret } from '../lib/db';
import { encryptToken } from '../lib/github';

export async function handleSecrets(req: Request, c: Ctx, id?: string): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });

  const project = c.url.searchParams.get('project') || '';
  if (!id) {
    if (req.method === 'GET') {
      const { results } = await listSecrets(c.env, c.user.id, project);
      return json({ secrets: results });
    }
    if (req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { name?: string; value?: string };
      const name = (b.name || '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return error(400, 'Name must be a valid identifier (letters, digits, underscore).');
      if (!b.value) return error(400, 'value required');
      const enc = await encryptToken(c.env, String(b.value));
      await upsertSecret(c.env, c.user.id, project, name, enc);
      return json({ ok: true });
    }
    return error(405, 'Method not allowed');
  }

  if (req.method === 'DELETE') {
    await deleteSecret(c.env, c.user.id, id);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}
