// BuildSession — a Durable Object that owns one app's build.
//
// Why this exists: app builds are long (an LLM streaming many files). If the build
// ran inside a normal request handler, refreshing or closing the tab would tear
// down that request — and, critically, ABORT the LLM subrequest it spawned — so the
// build would die before it saved ("still building… and no code was saved").
//
// The fix: the build runs inside the DO's `alarm()` handler, NOT inside a request.
// An alarm is independent of any browser connection: it can't be killed by a
// refresh, may run up to ~15 minutes, and (because alarms + storage are durable)
// survives the object being evicted. The browser merely ATTACHES to the DO's event
// stream; a reopened/refreshed tab re-attaches and replays everything so far.

import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionUser, Ctx } from '../types';
import { runBuild, type GenBody } from '../routes/generate';

interface Job {
  body: GenBody;
  user: SessionUser | null;
  deviceId: string;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
};

export class BuildSession extends DurableObject<Env> {
  private building = false;
  private projectId: string | null = null;
  // Replay buffer: every event broadcast so far, so a late/reconnecting tab can
  // catch up to live. Capped to bound memory on long builds.
  private events: { event: string; data: unknown }[] = [];
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private enc = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Restore "am I building?" if this object was just re-created (eviction/restart).
    ctx.blockConcurrencyWhile(async () => {
      this.building = !!(await ctx.storage.get('building'));
      this.projectId = (await ctx.storage.get<string>('projectId')) || null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    // Start the build (if idle) and attach to its live stream.
    if (path.endsWith('/run') && req.method === 'POST') {
      const job = (await req.json().catch(() => null)) as Job | null;
      if (job && !this.building) await this.begin(job);
      return this.attach();
    }
    // Reconnect a refreshed/reopened tab to an in-progress (or just-finished) build.
    if (path.endsWith('/attach')) return this.attach();
    if (path.endsWith('/status')) {
      return new Response(JSON.stringify({ building: this.building }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  }

  // Persist the job and schedule an immediate alarm to run it. Returns fast.
  private async begin(job: Job): Promise<void> {
    this.building = true;
    this.events = [];
    this.projectId = job.body.projectId || null;
    await this.ctx.storage.put({ building: true, projectId: this.projectId, job });
    if (this.projectId) {
      await this.env.KV.put(`build:${this.projectId}`, String(Date.now()), { expirationTtl: 3600 }).catch(() => {});
    }
    await this.ctx.storage.setAlarm(Date.now()); // fire ASAP, in its own context
  }

  // Runs the entire build. Independent of any client request, so a tab refresh
  // can't kill it; the DO stays alive for the whole handler (up to ~15 min).
  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<Job>('job');
    if (!job) { this.building = false; return; }
    this.building = true;
    this.projectId = job.body.projectId || null;
    const env = this.env;

    const send = async (event: string, data: unknown) => { this.broadcast(event, data); };
    const heartbeat = async () => {
      if (this.projectId) await env.KV.put(`build:${this.projectId}`, String(Date.now()), { expirationTtl: 3600 }).catch(() => {});
    };
    const c: Ctx = {
      env,
      ctx: this.ctx as unknown as ExecutionContext,
      url: new URL('https://build.yield/'),
      user: job.user,
      deviceId: job.deviceId,
    };

    try {
      await runBuild(c, job.body, send, heartbeat);
    } catch (e: any) {
      this.broadcast('error', { message: String(e?.message || e).slice(0, 400) });
    } finally {
      this.building = false;
      await this.ctx.storage.delete(['building', 'projectId', 'job']).catch(() => {});
      if (this.projectId) await env.KV.delete(`build:${this.projectId}`).catch(() => {});
      this.broadcast('end', {});
      for (const w of this.writers) { try { await w.close(); } catch { /* already gone */ } }
      this.writers.clear();
    }
  }

  // Push an event to the replay buffer and to every attached tab. High-volume live
  // 'code' deltas are NOT buffered for replay (the final files arrive via 'done');
  // a reconnecting tab still gets live code written from then on.
  private broadcast(event: string, data: unknown): void {
    if (event !== 'code') {
      this.events.push({ event, data });
      if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
    }
    const frame = this.enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const w of this.writers) {
      w.write(frame).catch(() => { this.writers.delete(w); }); // drop dead tabs
    }
  }

  // A fresh SSE stream: replay buffered events, then stream live ones.
  private attach(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    // No awaits => atomic w.r.t. concurrent broadcasts (DO is single-threaded),
    // so we never miss or duplicate an event between replay and going live.
    for (const e of this.events) {
      writer.write(this.enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)).catch(() => {});
    }
    if (this.building) {
      this.writers.add(writer);
    } else {
      writer.write(this.enc.encode('event: end\ndata: {}\n\n')).catch(() => {});
      writer.close().catch(() => {});
    }
    return new Response(readable, { headers: SSE_HEADERS });
  }
}
