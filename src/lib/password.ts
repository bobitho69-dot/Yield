// Email/password hashing using PBKDF2-SHA256 (WebCrypto, available on Workers).
// Stored format: pbkdf2$<iterations>$<base64 salt>$<base64 hash>

import { safeEqual } from './response';

const ENC = new TextEncoder();
const ITERATIONS = 100_000;

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

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB, hashB] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltB || !hashB) return false;
  const hash = await pbkdf2(password, unb64(saltB), parseInt(iterStr, 10) || ITERATIONS);
  return safeEqual(b64(hash), hashB);
}

// Light validation shared by signup.
export function validateCredentials(email: string, password: string): string | null {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address.';
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}
