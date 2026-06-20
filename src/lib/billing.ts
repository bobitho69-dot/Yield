// Stripe billing for the $20/mo "Priority Access" plan.
// Uses Stripe's REST API directly via fetch (no SDK) to stay light on Workers.

import type { Env } from '../types';
import { safeEqual } from './response';

const STRIPE_API = 'https://api.stripe.com/v1';

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function stripe(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} failed: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** Hosted Checkout for a monthly subscription. */
export async function createCheckout(env: Env, userId: string, email: string | null): Promise<string> {
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    success_url: `${env.APP_URL}/app?upgraded=1`,
    cancel_url: `${env.APP_URL}/app?upgrade=cancelled`,
    client_reference_id: userId,
    'metadata[user_id]': userId,
    allow_promotion_codes: 'true',
  };
  if (email) params.customer_email = email;
  const session = await stripe(env, '/checkout/sessions', params);
  return session.url as string;
}

/** Customer billing portal (manage/cancel). */
export async function createPortal(env: Env, customerId: string): Promise<string> {
  const session = await stripe(env, '/billing_portal/sessions', {
    customer: customerId,
    return_url: `${env.APP_URL}/app`,
  });
  return session.url as string;
}

// --- Webhook signature verification (Stripe-Signature: t=...,v1=...) -----------
export async function verifyWebhook(env: Env, payload: string, sigHeader: string | null): Promise<boolean> {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=')));
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return safeEqual(v1, expected);
}
