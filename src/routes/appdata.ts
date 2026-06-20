// App database (entities) — the SDK generated apps use to store/query data.
//   GET    /api/apps/:id/entities/:entity            list
//   POST   /api/apps/:id/entities/:entity            create (body = record)
//   GET    /api/apps/:id/entities/:entity/:recordId  get one
//   PUT    /api/apps/:id/entities/:entity/:recordId  update (merge)
//   DELETE /api/apps/:id/entities/:entity/:recordId  delete
// CORS-enabled so the sandboxed app (any end-user) can call it. Data is stored in
// the project owner's GitHub repo (or D1 fallback).

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { getProject } from '../lib/db';
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord, validEntity } from '../lib/appdata';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const j = (data: unknown, status = 200) => json(data, { status, headers: CORS });

export async function handleAppData(req: Request, c: Ctx, projectId: string, entity: string, recordId?: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!validEntity(entity)) return j({ error: 'Invalid entity name' }, 400);

  const project = await getProject(c.env, projectId);
  if (!project) return j({ error: 'App not found' }, 404);

  try {
    if (!recordId) {
      if (req.method === 'GET') return j({ records: await listRecords(c.env, project, entity) });
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        return j({ record: await createRecord(c.env, project, entity, body) }, 201);
      }
      return j({ error: 'Method not allowed' }, 405);
    }
    if (req.method === 'GET') {
      const rec = await getRecord(c.env, project, entity, recordId);
      return rec ? j({ record: rec }) : j({ error: 'Not found' }, 404);
    }
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      const rec = await updateRecord(c.env, project, entity, recordId, body);
      return rec ? j({ record: rec }) : j({ error: 'Not found' }, 404);
    }
    if (req.method === 'DELETE') {
      await deleteRecord(c.env, project, entity, recordId);
      return j({ ok: true });
    }
    return j({ error: 'Method not allowed' }, 405);
  } catch (e: any) {
    return j({ error: String(e?.message || e).slice(0, 200) }, 502);
  }
}
