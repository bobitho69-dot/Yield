// AI Agents — reusable AIs the user defines, callable from the builder and from
// generated apps.
//   GET    /api/agents            list
//   POST   /api/agents            create {name, description, system_prompt, model, is_public}
//   GET    /api/agents/:id        get
//   PUT    /api/agents/:id        update
//   DELETE /api/agents/:id        delete
//   POST   /api/agents/:id/run    run the agent {input, messages?} -> {output}  (CORS; public agents)

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { resolveModel, endpointFor } from '../config/models';
import { chat } from '../lib/nvidia';
import { createAgent, deleteAgent, getAgent, listAgents, logUsage, updateAgent } from '../lib/db';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function handleAgents(req: Request, c: Ctx, id?: string, sub?: string): Promise<Response> {
  // Run is callable cross-origin (from a sandboxed generated app).
  if (id && sub === 'run') {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'POST') return runAgent(req, c, id);
    return error(405, 'Method not allowed');
  }

  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });

  const project = c.url.searchParams.get('project') || undefined;
  if (!id) {
    if (req.method === 'GET') {
      const { results } = await listAgents(c.env, c.user.id, project);
      return json({ agents: results });
    }
    if (req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as any;
      if (!b.name || !b.system_prompt) return error(400, 'name and system_prompt are required');
      const agent = await createAgent(c.env, c.user.id, {
        name: String(b.name).slice(0, 80),
        description: b.description ? String(b.description).slice(0, 400) : undefined,
        system_prompt: String(b.system_prompt).slice(0, 8000),
        model: b.model || 'glm-5.2',
        is_public: b.is_public !== false,
        project_id: b.project_id || project || '',
      });
      return json({ agent }, { status: 201 });
    }
    return error(405, 'Method not allowed');
  }

  const agent = await getAgent(c.env, id);
  if (!agent) return error(404, 'Agent not found');
  if (agent.user_id !== c.user.id) return error(403, 'Not your agent');

  if (req.method === 'GET') return json({ agent });
  if (req.method === 'PUT') {
    const b = (await req.json().catch(() => ({}))) as any;
    await updateAgent(c.env, id, {
      name: b.name, description: b.description, system_prompt: b.system_prompt, model: b.model, is_public: b.is_public,
    });
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await deleteAgent(c.env, id);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

async function runAgent(req: Request, c: Ctx, id: string): Promise<Response> {
  const agent = await getAgent(c.env, id);
  if (!agent) return json({ error: 'Agent not found' }, { status: 404, headers: CORS });
  const owner = c.user && agent.user_id === c.user.id;
  if (!agent.is_public && !owner) return json({ error: 'This agent is private.' }, { status: 403, headers: CORS });

  const gate = await gateGeneration(c);
  if (!gate.allowed) return json({ error: gate.reason, code: gate.code }, { status: gate.status, headers: CORS });

  const body = (await req.json().catch(() => ({}))) as { input?: string; messages?: { role: string; content: string }[] };
  const input = (body.input || '').toString().slice(0, 12000);
  if (!input && !body.messages?.length) return json({ error: 'input required' }, { status: 400, headers: CORS });

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: agent.system_prompt },
  ];
  for (const m of body.messages || []) {
    if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: String(m.content).slice(0, 8000) });
  }
  if (input) messages.push({ role: 'user', content: input });

  // Runtime agents must be SNAPPY (they power chatbots/assistants in live apps), so
  // run them with LOW reasoning and a short per-try timeout. Try the agent's model,
  // then fast fallbacks ending with gpt-oss (the model the router uses, so we know
  // it works). For each model: low reasoning first, then plain if the flag is
  // rejected — a placeholder id, a slow/looping reasoner, or empty content never
  // hangs the agent.
  const candidates = [agent.model, 'deepseek-v4-flash', 'glm-5.2', 'minimax-m3', 'auto'];
  const seen = new Set<string>();
  let lastErr = 'No model was able to respond.';
  for (const cid of candidates) {
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const m = resolveModel(cid);
    const e = endpointFor(c.env, m);
    for (const eff of ['low', null] as const) {
      try {
        const { text } = await chat({
          baseUrl: e.baseUrl, apiKey: e.apiKey, apiKeyBackup: e.apiKeyBackup, model: e.modelId, messages,
          max_tokens: 4000, timeoutMs: 40000,
          ...(eff ? { extra: { reasoning_effort: eff } } : {}),
        });
        if (text && text.trim()) {
          await recordGeneration(c);
          await logUsage(c.env, { user_id: agent.user_id, kind: 'agent', model: m.id, high_usage: gate.usage.highUsage });
          return json({ output: text, agent: agent.name, model: m.id }, { headers: CORS });
        }
        lastErr = `Empty response from ${m.id}.`;
        break; // clean but empty — try the next model
      } catch (err: any) {
        lastErr = String(err?.message || err);
        // A timeout means the model is hanging — go straight to the next model
        // instead of burning another full timeout on a plain retry.
        if (/abort/i.test(lastErr)) break;
        // Otherwise the reasoning flag may have been rejected -> retry plainly.
      }
    }
  }
  return json({ error: lastErr.slice(0, 300) }, { status: 502, headers: CORS });
}
