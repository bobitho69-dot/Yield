// BuildSession — a Durable Object that owns one app's build.
//
// Why this exists: app builds are long (an LLM streaming many files). If the build
// ran inside the normal request handler, refreshing or closing the tab would tear
// down the request context and the work would be lost — "still building… and no
// code was saved". A Durable Object has its own lifetime, independent of any
// browser connection, so the build runs to completion (and persists to D1 + GitHub)
// no matter what the tab does. Browser tabs simply ATTACH to the DO's event stream;
// a reopened tab re-attaches and replays everything that happened so far.

import { DurableObject } from 'cloudflare:workers';
import type { Env, SessionUser, Ctx } from '../types';
import { runBuild, type GenBody } from '../routes/generate';

interface StartMsg {
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
  // catch up to the live state. Capped to avoid unbounded memory on long builds.
  private events: { event: string; data: unknown }[] = [];
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private enc = new TextEncoder();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Start (if idle) and attach to the live stream.
    if (path.endsWith('/run') && req.method === 'POST') {
      const msg = (await req.json().catch(() => null)) as StartMsg | null;
      if (msg && !this.building) this.startBuild(msg);
      return this.attach();
    }
    // Re-attach a reconnecting tab to an in-progress (or just-finished) build.
    if (path.endsWith('/attach')) {
      return this.attach();
    }
    if (path.endsWith('/status')) {
      return new Response(JSON.stringify({ building: this.building }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  }

  private startBuild(msg: StartMsg): void {
    this.building = true;
    this.events = [];
    this.projectId = msg.body.projectId || null;
    const env = this.env;

    const send = async (event: string, data: unknown) => { this.broadcast(event, data); };
    const setFlag = (ttl: number) =>
      this.projectId ? env.KV.put(`build:${this.projectId}`, String(Date.now()), { expirationTtl: ttl }).catch(() => {}) : Promise.resolve();
    const heartbeat = async () => { await setFlag(3600); };

    // Synthetic request context: the DO has env + the resolved user, which is all
    // the build pipeline needs (it never touches cookies or the live request).
    const c: Ctx = {
      env,
      ctx: this.ctx as unknown as ExecutionContext, // DurableObjectState has waitUntil()
      url: new URL('https://build.yield/'),
      user: msg.user,
      deviceId: msg.deviceId,
    };

    const work = (async () => {
      await setFlag(3600); // mark building immediately
      try {
        await runBuild(c, msg.body, send, heartbeat);
      } catch (e: any) {
        this.broadcast('error', { message: String(e?.message || e).slice(0, 400) });
      } finally {
        this.building = false;
        if (this.projectId) await env.KV.delete(`build:${this.projectId}`).catch(() => {});
        // Tell attached tabs the build is over, then close their streams.
        this.broadcast('end', {});
        for (const w of this.writers) { try { await w.close(); } catch { /* already gone */ } }
        this.writers.clear();
      }
    })();
    // Keep the DO alive until the build fully completes, regardless of any client.
    this.ctx.waitUntil(work);
  }

  // Push an event to the replay buffer and to every attached tab.
  private broadcast(event: string, data: unknown): void {
    this.events.push({ event, data });
    if (this.events.length > 6000) this.events.splice(0, this.events.length - 6000);
    const frame = this.enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const w of this.writers) {
      // Fire-and-forget; drop writers whose tab has gone away.
      w.write(frame).catch(() => { this.writers.delete(w); });
    }
  }

  // Return a fresh SSE stream: replays buffered events, then streams live ones.
  private attach(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    // No awaits here => atomic w.r.t. concurrent broadcasts (the DO is single-threaded),
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
