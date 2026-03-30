// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Stripe Payment Worker
// Cloudflare Worker handling subscriptions + Miracle Model gifting
//
// Endpoints:
//   POST /create-checkout    → Creates Stripe Checkout Session
//   POST /webhook            → Handles Stripe webhook events
//   POST /portal             → Creates Stripe Customer Portal session
//   GET  /status/:email      → Returns subscription status for a user
//
// Secrets (set via wrangler secret put):
//   STRIPE_SECRET_KEY        → sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET    → whsec_...
//   STRIPE_SHEPHERD_PRICE    → price_... (Shepherd $9/mo)
//   STRIPE_COMMISSION_PRICE  → price_... (Commission $19/mo)
//
// Deploy: cd stripe-worker && npx wrangler deploy
// ═══════════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // Lock to lordsguide.com in production
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Stripe REST helpers (no SDK needed — pure fetch) ──
async function stripeRequest(path, params, secretKey, method = 'POST') {
  const body = new URLSearchParams();
  flattenParams(params, body);

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method !== 'GET' ? body.toString() : undefined,
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// Flatten nested objects for Stripe's form encoding
function flattenParams(obj, params, prefix = '') {
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      flattenParams(val, params, fullKey);
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v === 'object') flattenParams(v, params, `${fullKey}[${i}]`);
        else params.append(`${fullKey}[${i}]`, v);
      });
    } else if (val !== undefined && val !== null) {
      params.append(fullKey, val);
    }
  }
}

// ── Webhook signature verification (using Web Crypto) ──
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [key, val] = part.split('=');
    acc[key.trim()] = val;
    return acc;
  }, {});

  const timestamp = parts.t;
  const signature = parts.v1;

  if (!timestamp || !signature) throw new Error('Invalid signature header');

  // Check timestamp (reject events older than 5 minutes)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) throw new Error('Webhook timestamp too old');

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected !== signature) throw new Error('Invalid signature');
  return JSON.parse(payload);
}

// ── KV helpers for subscription tracking ──
async function getSubscription(kv, email) {
  try {
    const data = await kv.get(`sub:${email}`, 'json');
    return data || null;
  } catch { return null; }
}

async function setSubscription(kv, email, data) {
  await kv.put(`sub:${email}`, JSON.stringify(data), { expirationTtl: 86400 * 400 }); // ~13 months
}

async function incrementMiracleCounter(kv, count = 1) {
  const current = parseInt(await kv.get('miracle-count') || '0');
  await kv.put('miracle-count', String(current + count));
  return current + count;
}

async function getMiracleCount(kv) {
  return parseInt(await kv.get('miracle-count') || '0');
}

// ── Main Worker ──
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ━━━ CREATE CHECKOUT SESSION ━━━
      if (path === '/create-checkout' && request.method === 'POST') {
        const { tier, email, name, successUrl, cancelUrl } = await request.json();

        if (!tier || !email) {
          return jsonResponse({ error: 'Missing tier or email' }, 400);
        }

        const priceId = tier === 'commission'
          ? env.STRIPE_COMMISSION_PRICE
          : env.STRIPE_SHEPHERD_PRICE;

        if (!priceId) {
          return jsonResponse({ error: 'Price not configured' }, 500);
        }

        const session = await stripeRequest('/checkout/sessions', {
          mode: 'subscription',
          'line_items[0][price]': priceId,
          'line_items[0][quantity]': '1',
          customer_email: email,
          success_url: successUrl || 'https://lordsguide.com?payment=success&tier=' + tier,
          cancel_url: cancelUrl || 'https://lordsguide.com?payment=cancelled',
          'metadata[tier]': tier,
          'metadata[name]': name || 'Beloved',
          'metadata[app]': 'lordsguide',
          'subscription_data[metadata][tier]': tier,
          'subscription_data[metadata][name]': name || 'Beloved',
        }, env.STRIPE_SECRET_KEY);

        return jsonResponse({ url: session.url, sessionId: session.id });
      }

      // ━━━ STRIPE WEBHOOK ━━━
      if (path === '/webhook' && request.method === 'POST') {
        const body = await request.text();
        const sig = request.headers.get('stripe-signature');

        if (!sig) return jsonResponse({ error: 'No signature' }, 400);

        let event;
        try {
          event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
        } catch (e) {
          return jsonResponse({ error: 'Invalid signature: ' + e.message }, 400);
        }

        // Handle subscription events
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object;
            if (session.mode === 'subscription') {
              const email = session.customer_email;
              const tier = session.metadata?.tier || 'shepherd';
              const name = session.metadata?.name || 'Beloved';
              const miraclesGifted = tier === 'commission' ? 3 : 1;

              // Store subscription
              await setSubscription(env.LORDSGUIDE_KV, email, {
                tier,
                name,
                customerId: session.customer,
                subscriptionId: session.subscription,
                status: 'active',
                miraclesGifted,
                createdAt: new Date().toISOString(),
              });

              // Increment miracle counter
              await incrementMiracleCounter(env.LORDSGUIDE_KV, miraclesGifted);

              console.log(`✝ New ${tier} subscriber: ${email} — ${miraclesGifted} miracle(s) gifted`);
            }
            break;
          }

          case 'customer.subscription.updated': {
            const sub = event.data.object;
            const email = sub.metadata?.email || '';
            if (email) {
              const existing = await getSubscription(env.LORDSGUIDE_KV, email);
              if (existing) {
                existing.status = sub.status; // active, past_due, canceled, etc.
                await setSubscription(env.LORDSGUIDE_KV, email, existing);
              }
            }
            break;
          }

          case 'customer.subscription.deleted': {
            const sub = event.data.object;
            const email = sub.metadata?.email || '';
            if (email) {
              const existing = await getSubscription(env.LORDSGUIDE_KV, email);
              if (existing) {
                existing.status = 'canceled';
                existing.canceledAt = new Date().toISOString();
                await setSubscription(env.LORDSGUIDE_KV, email, existing);
              }
            }
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object;
            console.log(`⚠ Payment failed for customer: ${invoice.customer}`);
            break;
          }
        }

        return jsonResponse({ received: true });
      }

      // ━━━ CUSTOMER PORTAL (manage subscription) ━━━
      if (path === '/portal' && request.method === 'POST') {
        const { email } = await request.json();
        if (!email) return jsonResponse({ error: 'Missing email' }, 400);

        const sub = await getSubscription(env.LORDSGUIDE_KV, email);
        if (!sub?.customerId) {
          return jsonResponse({ error: 'No subscription found' }, 404);
        }

        const session = await stripeRequest('/billing_portal/sessions', {
          customer: sub.customerId,
          return_url: 'https://lordsguide.com',
        }, env.STRIPE_SECRET_KEY);

        return jsonResponse({ url: session.url });
      }

      // ━━━ SUBSCRIPTION STATUS ━━━
      if (path.startsWith('/status/') && request.method === 'GET') {
        const email = decodeURIComponent(path.replace('/status/', ''));
        if (!email) return jsonResponse({ error: 'Missing email' }, 400);

        const sub = await getSubscription(env.LORDSGUIDE_KV, email);
        const miracleCount = await getMiracleCount(env.LORDSGUIDE_KV);

        return jsonResponse({
          subscription: sub ? {
            tier: sub.tier,
            status: sub.status,
            miraclesGifted: sub.miraclesGifted,
            createdAt: sub.createdAt,
          } : null,
          globalMiracleCount: miracleCount,
        });
      }

      // ━━━ MIRACLE COUNT (public) ━━━
      if (path === '/miracle-count' && request.method === 'GET') {
        const count = await getMiracleCount(env.LORDSGUIDE_KV);
        return jsonResponse({ count });
      }

      // ━━━ HEALTH CHECK ━━━
      if (path === '/' || path === '/health') {
        return jsonResponse({
          status: 'ok',
          service: 'LordsGuide Payment System',
          endpoints: ['/create-checkout', '/webhook', '/portal', '/status/:email', '/miracle-count'],
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (e) {
      console.error('Payment error:', e.message);
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
