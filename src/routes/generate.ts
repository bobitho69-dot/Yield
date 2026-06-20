// POST /api/generate  — prompt -> app (streaming SSE)
// POST /api/route     — auto-pick the best coder model for a prompt (gpt-oss-20b)
//
// Pipeline: jailbreak guard -> usage gate -> model resolve (auto) -> stream codegen
//           -> persist code + messages -> record usage.

import type { Ctx } from '../types';
import { sse, json, error, now } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { CODER_MODELS, ROUTER_MODEL, resolveModel } from '../config/models';
import { chat, chatStream, extractHtml } from '../lib/nvidia';
import { CODEGEN_SYSTEM, editInstruction, routerSystem } from '../lib/prompts';
import { addMessage, createProject, getProject, logUsage, saveProjectCode } from '../lib/db';
import { syncProjectToGithub } from './githubRoutes';

interface GenBody {
  prompt: string;
  model?: string; // friendly id or 'auto'
  projectId?: string; // when editing an existing app
}

// Use gpt-oss-20b to choose the best coder model. Falls back to a heuristic.
export async function routeModel(c: Ctx, prompt: string): Promise<{ id: string; reason: string }> {
  const menu = CODER_MODELS.map((m) => ({ id: m.id, tier: m.tier, blurb: m.blurb }));
  try {
    const router = resolveModel(ROUTER_MODEL.id);
    const { text } = await chat(c.env, {
      model: router.nvidiaId,
      messages: [
        { role: 'system', content: routerSystem(menu) },
        { role: 'user', content: prompt.slice(0, 4000) },
      ],
      temperature: 0,
      max_tokens: 120,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { model?: string; reason?: string };
      if (parsed.model && CODER_MODELS.some((x) => x.id === parsed.model)) {
        return { id: parsed.model, reason: parsed.reason || 'auto-selected' };
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  // Heuristic fallback by prompt length/complexity.
  const len = prompt.length;
  if (len > 600) return { id: 'deepseek-v4-pro', reason: 'complex request (fallback)' };
  if (len > 200) return { id: 'glm-5.1', reason: 'standard request (fallback)' };
  return { id: 'deepseek-v4-flash', reason: 'quick request (fallback)' };
}

export async function handleRoute(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  if (!body.prompt) return error(400, 'prompt required');
  const choice = await routeModel(c, body.prompt);
  return json(choice);
}

export async function handleGenerate(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');
  if (prompt.length > 12000) return error(413, 'prompt too long');

  // 1) Jailbreak / exploit guard (NeMoGuard).
  const guard = await checkPrompt(c.env, prompt);
  if (guard.blocked) {
    if (body.projectId) {
      await addMessage(c.env, { project_id: body.projectId, role: 'user', content: prompt, flagged: true });
    }
    await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'blocked' });
    return error(451, 'This prompt was blocked by the safety guard.', {
      code: 'jailbreak_blocked',
      detail: guard.reason,
      score: guard.score,
    });
  }

  // 2) Usage gate (High Usage Times + daily limits).
  const gate = await gateGeneration(c);
  if (!gate.allowed) {
    return error(gate.status, gate.reason || 'Not allowed right now.', { code: gate.code, highUsage: gate.usage.highUsage });
  }

  // 3) Resolve the model (Auto -> route via gpt-oss-20b).
  let modelId = body.model || 'auto';
  let routeReason: string | undefined;
  if (modelId === 'auto') {
    const choice = await routeModel(c, prompt);
    modelId = choice.id;
    routeReason = choice.reason;
  }
  const model = resolveModel(modelId);

  // 4) Project: create lazily for anonymous/no-project requests is skipped — we
  //    only persist for signed-in users with a project. Anonymous gets ephemeral output.
  let project = body.projectId ? await getProject(c.env, body.projectId) : null;
  if (project && c.user && project.user_id !== c.user.id) return error(403, 'Not your project.');
  if (!project && c.user) {
    project = await createProject(c.env, c.user.id, prompt.slice(0, 60));
  }

  // 5) Build the message list (include current code when editing).
  const messages = [
    { role: 'system' as const, content: CODEGEN_SYSTEM },
    {
      role: 'user' as const,
      content: project && project.code ? editInstruction(project.code, prompt) : prompt,
    },
  ];

  // 6) Stream it back as SSE.
  const { response, send, close } = sse();
  c.ctx.waitUntil(
    (async () => {
      try {
        await send('meta', { model: model.id, label: model.label, projectId: project?.id ?? null, routeReason });
        const { text } = await chatStream(c.env, { model: model.nvidiaId, messages, max_tokens: 16384 }, async (delta) => {
          await send('delta', delta);
        });
        const code = extractHtml(text);
        await send('done', { code, projectId: project?.id ?? null });

        // Persist (signed-in users only).
        if (project && c.user) {
          await saveProjectCode(c.env, project.id, code, model.id);
          await addMessage(c.env, { project_id: project.id, role: 'user', content: prompt });
          await addMessage(c.env, { project_id: project.id, role: 'assistant', content: '[generated app]', model: model.id });
          // Auto-push to GitHub if this project is linked to a repo.
          await syncProjectToGithub(c, project, code);
        }
        await recordGeneration(c);
        await logUsage(c.env, { user_id: c.user?.id ?? null, kind: project?.code ? 'edit' : 'generate', model: model.id, high_usage: gate.usage.highUsage });
      } catch (e: any) {
        await send('error', { message: String(e?.message || e).slice(0, 300) });
      } finally {
        await close();
      }
    })(),
  );
  return response;
}
