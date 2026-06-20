// Stripe billing endpoints.
//   POST /api/billing/checkout   -> { url } hosted checkout for $20/mo
//   POST /api/billing/portal     -> { url } manage subscription
//   POST /api/billing/webhook    -> Stripe events (sub created/updated/deleted)
//   GET  /api/billing/status     -> { plan, renews_at }

import type { Ctx } from '../types';
import { json, error, now } from '../lib/response';
import { createCheckout, createPortal, verifyWebhook } from '../lib/billing';
import { getUser, getUserByCustomer, setUserPlan } from '../lib/db';

export async function handleBilling(req: Request, c: Ctx, action?: string): Promise<Response> {
  if (action === 'webhook') return handleWebhook(req, c);

  if (action === 'status') {
    if (!c.user) return json({ plan: 'anonymous' });
    const u = await getUser(c.env, c.user.id);
    return json({ plan: u?.plan ?? 'free', renews_at: u?.plan_renews_at ?? null });
  }

  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });

  if (action === 'checkout' && req.method === 'POST') {
    const url = await createCheckout(c.env, c.user.id, c.user.email);
    return json({ url });
  }

  if (action === 'portal' && req.method === 'POST') {
    const u = await getUser(c.env, c.user.id);
    if (!u?.stripe_customer_id) return error(400, 'No billing account yet.');
    const url = await createPortal(c.env, u.stripe_customer_id);
    return json({ url });
  }

  return error(404, 'Not found');
}

async function handleWebhook(req: Request, c: Ctx): Promise<Response> {
  const payload = await req.text();
  const ok = await verifyWebhook(c.env, payload, req.headers.get('stripe-signature'));
  if (!ok) return error(400, 'Invalid signature');

  const event = JSON.parse(payload) as any;
  const obj = event.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id || obj.metadata?.user_id;
      if (userId) {
        await setUserPlan(c.env, userId, 'priority', {
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
        });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const user = await getUserByCustomer(c.env, obj.customer);
      if (user) {
        const active = obj.status === 'active' || obj.status === 'trialing';
        await setUserPlan(c.env, user.id, active ? 'priority' : 'free', {
          stripe_subscription_id: obj.id,
          plan_renews_at: obj.current_period_end ?? null,
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const user = await getUserByCustomer(c.env, obj.customer);
      if (user) await setUserPlan(c.env, user.id, 'free');
      break;
    }
  }
  return json({ received: true });
}
