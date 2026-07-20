// Stripe billing endpoints.
//   POST /api/billing/checkout   -> { url } hosted checkout for $20/mo
//   POST /api/billing/portal     -> { url } manage subscription
//   POST /api/billing/webhook    -> Stripe events (sub created/updated/deleted)
//   GET  /api/billing/status     -> { plan, renews_at }

import type { Ctx } from '../types';
import { json, error, now } from '../lib/response';
import { createCheckout, createPortal, verifyWebhook } from '../lib/billing';
import { getUser, getUserByCustomer, getUserBySecuritySub, setUserPlan, setUserSecurity } from '../lib/db';

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

  const isSecurity = obj.metadata?.product === 'security';

  // True if a subscription contains a line item for `priceId` — so ONLY the real Priority
  // (or Security) price grants that entitlement, never just any subscription on the customer
  // (e.g. a Security-only sub, or a dashboard-created one, must not unlock Priority).
  const subHasPrice = (o: any, priceId?: string): boolean => {
    if (!priceId) return false;
    const items = o?.items?.data;
    return Array.isArray(items) && items.some((it: any) => it?.price?.id === priceId || it?.plan?.id === priceId);
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id || obj.metadata?.user_id;
      if (userId && isSecurity) {
        await setUserSecurity(c.env, userId, true, { stripe_customer_id: obj.customer, security_subscription_id: obj.subscription });
      } else if (userId) {
        await setUserPlan(c.env, userId, 'priority', { stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const active = obj.status === 'active' || obj.status === 'trialing';
      const isSec = isSecurity || subHasPrice(obj, c.env.SECURITY_PRICE_ID);
      const isPriority = subHasPrice(obj, c.env.STRIPE_PRICE_ID);
      if (isSec) {
        const user = (await getUserBySecuritySub(c.env, obj.id)) || (await getUserByCustomer(c.env, obj.customer));
        if (user) await setUserSecurity(c.env, user.id, active, { security_subscription_id: obj.id });
      } else if (isPriority) {
        const user = await getUserByCustomer(c.env, obj.customer);
        if (user) await setUserPlan(c.env, user.id, active ? 'priority' : 'free', { stripe_subscription_id: obj.id, plan_renews_at: obj.current_period_end ?? null });
      }
      // Any other price on the customer's account is ignored — it must never grant Priority.
      break;
    }
    case 'customer.subscription.deleted': {
      const isSec = isSecurity || subHasPrice(obj, c.env.SECURITY_PRICE_ID);
      const isPriority = subHasPrice(obj, c.env.STRIPE_PRICE_ID);
      if (isSec) {
        const user = (await getUserBySecuritySub(c.env, obj.id)) || (await getUserByCustomer(c.env, obj.customer));
        if (user) await setUserSecurity(c.env, user.id, false);
      } else if (isPriority) {
        const user = await getUserByCustomer(c.env, obj.customer);
        if (user) await setUserPlan(c.env, user.id, 'free');
      }
      break;
    }
  }
  return json({ received: true });
}
