# ✝ LordsGuide — Stripe Payment Setup Guide

## Overview
This adds real payments to LordsGuide. After setup:
- Users click "Shepherd $9/mo" → Stripe Checkout opens → they pay → they're subscribed
- The Miracle counter increments automatically
- The Viral Blessing modal fires with real data
- Users can manage/cancel via Stripe Customer Portal

Total setup time: ~20 minutes.
Monthly cost: $0 (Stripe charges 2.9% + $0.30 per transaction only).

---

## Step 1: Create a Stripe Account (5 minutes)

1. Go to https://dashboard.stripe.com/register
2. Sign up with your email
3. Complete the business profile:
   - Business name: Artisans F&B Corp
   - Country: Philippines
   - Business type: Individual/Sole proprietor
4. You'll start in TEST MODE (orange banner at top)
   - This is perfect — test everything before going live

---

## Step 2: Create Your Products and Prices (3 minutes)

In the Stripe Dashboard:

1. Click "Product catalog" in the left sidebar
2. Click "+ Add product"

**Product 1: Shepherd**
- Name: LordsGuide Shepherd
- Description: AI-powered sermon prep, Bible study, and community. Your subscription gifts a free Miracle account to a pastor in need.
- Click "Add price"
  - Price: $9.00
  - Billing period: Monthly
  - Currency: USD
- Click "Save product"
- **Copy the Price ID** (starts with price_...) — you'll need it

**Product 2: The Great Commission**
- Name: LordsGuide Great Commission
- Description: Everything in Shepherd plus 5 team seats and shared sermon library. Your subscription gifts 3 free Miracle accounts.
- Click "Add price"
  - Price: $19.00
  - Billing period: Monthly
  - Currency: USD
- Click "Save product"
- **Copy the Price ID** (starts with price_...)

---

## Step 3: Get Your API Keys (1 minute)

1. In Stripe Dashboard → Developers → API keys
2. Copy your **Secret key** (starts with sk_test_... for test mode)
3. You'll also need your **Publishable key** (starts with pk_test_...)

---

## Step 4: Create the KV Namespace (2 minutes)

In your terminal:

```bash
cd lordsguide-stripe
npx wrangler kv namespace create LORDSGUIDE_KV
```

This prints something like:
```
{ binding = "LORDSGUIDE_KV", id = "abc123def456..." }
```

Copy that ID and paste it into wrangler.toml, replacing REPLACE_WITH_YOUR_KV_NAMESPACE_ID

---

## Step 5: Set Secrets (2 minutes)

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# Paste: sk_test_... (your Stripe secret key)

npx wrangler secret put STRIPE_WEBHOOK_SECRET
# We'll set this after Step 7 — skip for now

npx wrangler secret put STRIPE_SHEPHERD_PRICE
# Paste: price_... (Shepherd price ID from Step 2)

npx wrangler secret put STRIPE_COMMISSION_PRICE
# Paste: price_... (Commission price ID from Step 2)
```

---

## Step 6: Deploy the Payment Worker (1 minute)

```bash
npx wrangler deploy
```

Note the URL it prints (e.g., https://lg-payments.kevin123.workers.dev)

---

## Step 7: Set Up the Stripe Webhook (3 minutes)

1. In Stripe Dashboard → Developers → Webhooks
2. Click "+ Add endpoint"
3. Endpoint URL: https://lg-payments.YOUR-SUBDOMAIN.workers.dev/webhook
4. Select events:
   - checkout.session.completed
   - customer.subscription.updated
   - customer.subscription.deleted
   - invoice.payment_failed
5. Click "Add endpoint"
6. On the endpoint page, click "Reveal" next to "Signing secret"
7. Copy the signing secret (starts with whsec_...)
8. Back in terminal:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# Paste: whsec_... (the signing secret)
```

---

## Step 8: Connect the App to the Payment Worker

In your LordsGuide app, the signup buttons need to call the payment worker.

When a user clicks "Shepherd $9/mo" or "Great Commission $19/mo":

```javascript
// In the app — call when user selects a paid tier
async function startCheckout(tier, email, name) {
  const res = await fetch('https://lg-payments.YOUR-SUBDOMAIN.workers.dev/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tier,        // "shepherd" or "commission"
      email,       // user's email
      name,        // user's name
      successUrl: 'https://lordsguide.com?payment=success&tier=' + tier,
      cancelUrl: 'https://lordsguide.com?payment=cancelled',
    }),
  });
  const { url } = await res.json();
  window.location.href = url; // Redirect to Stripe Checkout
}
```

After payment, Stripe redirects back to lordsguide.com with ?payment=success.
The app detects this and shows the Viral Blessing modal.

---

## Step 9: Test Everything (5 minutes)

Stripe provides test card numbers:
- **Success**: 4242 4242 4242 4242 (any future expiry, any CVC)
- **Decline**: 4000 0000 0000 0002
- **3D Secure**: 4000 0025 0000 3155

1. Open lordsguide.com
2. Click "Shepherd $9/mo"
3. Enter test card 4242 4242 4242 4242
4. Complete checkout
5. Check Stripe Dashboard → Payments — you should see the test payment
6. Check your Worker logs: `npx wrangler tail lg-payments`
7. Visit https://lg-payments.YOUR-SUBDOMAIN.workers.dev/miracle-count
   - Should show { "count": 1 }

---

## Step 10: Go Live

When ready for real payments:
1. Stripe Dashboard → complete your business verification
2. Toggle from "Test mode" to "Live mode" (top of dashboard)
3. Get your LIVE keys (sk_live_..., pk_live_...)
4. Create LIVE products and prices (same as Step 2 but in live mode)
5. Update secrets:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY    # sk_live_...
   npx wrangler secret put STRIPE_SHEPHERD_PRICE  # live price_...
   npx wrangler secret put STRIPE_COMMISSION_PRICE # live price_...
   ```
6. Update webhook endpoint to use live signing secret
7. Lock CORS in worker.js to 'https://lordsguide.com'

---

## How the Miracle Model Works Technically

```
User clicks "Shepherd $9/mo"
    ↓
App calls /create-checkout with tier="shepherd"
    ↓
Worker creates Stripe Checkout Session
    ↓
User pays on Stripe's hosted page
    ↓
Stripe sends webhook: checkout.session.completed
    ↓
Worker receives webhook → verifies signature
    ↓
Worker stores subscription in KV: sub:{email} = {tier, status, ...}
    ↓
Worker increments miracle-count by 1 (or 3 for commission)
    ↓
User returns to lordsguide.com?payment=success
    ↓
App detects success → shows Viral Blessing modal
    ↓
"You just blessed a pastor" → Share the Blessing
```

---

## Architecture

```
lordsguide.com (Cloudflare Pages)
    ↓ Checkout request
lg-payments (Cloudflare Worker) ←→ Stripe API
    ↓ Stores data
LORDSGUIDE_KV (Cloudflare KV)
    ↑ Reads status
lordsguide.com checks /status/:email
```

Monthly cost: $0 base. Stripe takes 2.9% + $0.30 per transaction.
At 2,600 paid users: ~$870/month in Stripe fees.
Net from $29,900 gross: ~$29,030/month.

---

*"Freely ye have received, freely give." — Matthew 10:8*
