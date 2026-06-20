// GitHub code storage: encrypt the user's token at rest, create/link repos, and
// push generated code via the GitHub Contents API.

import type { Env } from '../types';
import { sessionSecret } from './auth';

const API = 'https://api.github.com';
const ENC = new TextEncoder();
const DEC = new TextDecoder();

// --- Token encryption (AES-GCM, key derived from SESSION_SECRET) ---------------
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', ENC.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function encryptToken(env: Env, plain: string): Promise<string> {
  const key = await aesKey(sessionSecret(env));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function decryptToken(env: Env, blob: string): Promise<string> {
  const [ivB, ctB] = blob.split('.');
  const key = await aesKey(sessionSecret(env));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(ctB));
  return DEC.decode(pt);
}

// --- API helpers --------------------------------------------------------------
async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'Yield',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

export async function getAuthedLogin(token: string): Promise<string | null> {
  const r = await gh(token, '/user');
  if (!r.ok) return null;
  const u: any = await r.json();
  return u.login ?? null;
}

export interface RepoInfo { full_name: string; html_url: string; default_branch: string; private: boolean; }

export async function listRepos(token: string): Promise<RepoInfo[]> {
  const r = await gh(token, '/user/repos?per_page=100&sort=updated&affiliation=owner');
  if (!r.ok) return [];
  const arr: any[] = await r.json();
  return arr.map((x) => ({ full_name: x.full_name, html_url: x.html_url, default_branch: x.default_branch, private: x.private }));
}

export async function createRepo(token: string, name: string, isPrivate: boolean, description: string): Promise<RepoInfo> {
  const r = await gh(token, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name, private: isPrivate, description, auto_init: true }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.message || 'Failed to create repo');
  return { full_name: data.full_name, html_url: data.html_url, default_branch: data.default_branch || 'main', private: data.private };
}

async function getFileSha(token: string, owner: string, repo: string, path: string, branch: string): Promise<string | null> {
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`);
  if (!r.ok) return null;
  const data: any = await r.json();
  return data?.sha ?? null;
}

async function putFile(
  token: string, owner: string, repo: string, path: string, content: string, message: string, branch: string,
): Promise<void> {
  const sha = await getFileSha(token, owner, repo, path, branch);
  const r = await gh(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: b64(ENC.encode(content)),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) {
    const e: any = await r.json().catch(() => ({}));
    throw new Error(e?.message || `Failed to write ${path}`);
  }
}

const README = (title: string) =>
  `# ${title}\n\nBuilt with [Yield](https://yield.example.workers.dev) — a free AI coder.\n\nThe app is a single self-contained file: open \`index.html\` in any browser.\n`;

/** Push all of a project's files (+ README) to a repo. */
export async function pushFiles(
  token: string, fullName: string, branch: string, title: string, files: { path: string; content: string }[],
): Promise<void> {
  const [owner, repo] = fullName.split('/');
  for (const f of files) {
    await putFile(token, owner, repo, f.path, f.content ?? '', `Yield: update ${f.path}`, branch);
  }
  // Write the README only if missing (first push).
  if (!(await getFileSha(token, owner, repo, 'README.md', branch))) {
    await putFile(token, owner, repo, 'README.md', README(title), 'Yield: add README', branch);
  }
}

export function slugify(s: string): string {
  return (s || 'yield-app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'yield-app';
}
