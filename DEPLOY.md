# ✝ LordsGuide — Complete Deployment Guide
# From laptop to live in under 30 minutes

## Prerequisites
- Node.js 18+ installed (`node -v` to check)
- Git installed (`git -v` to check)
- npm installed (comes with Node)
- Cloudflare account (dash.cloudflare.com)
- Anthropic API key (console.anthropic.com)
- GitHub account (github.com)

## Step 1: Unzip and Explore (2 minutes)
```bash
unzip lordsguide-complete.zip -d lordsguide
cd lordsguide
```

## Step 2: Deploy the API Proxy — keeps your key safe (5 minutes)
```bash
cd api-proxy
npx wrangler login          # opens browser to auth with Cloudflare
npx wrangler deploy          # deploys the Worker
npx wrangler secret put ANTHROPIC_API_KEY
# paste your Anthropic API key when prompted — it stays server-side
```
Note the Worker URL it prints (e.g., `https://lg-api-proxy.xxx.workers.dev`)

## Step 3: Build and Deploy the Frontend (5 minutes)
```bash
cd ..                        # back to project root
npm install                  # install React + Vite
npm test                     # should show "ALL TESTS PASSED"
npm run build                # builds to dist/
npx wrangler pages deploy dist --project-name=lordsguide
```

## Step 4: Connect Your Domain (3 minutes)
1. Go to dash.cloudflare.com → Pages → lordsguide
2. Custom domains → Add → lordsguide.com
3. SSL is automatic (Cloudflare handles it)

## Step 5: Set Environment Variable (2 minutes)
1. dash.cloudflare.com → Pages → lordsguide → Settings → Environment variables
2. Add: VITE_ANTHROPIC_PROXY_URL = (your Worker URL from Step 2)
3. Redeploy: `npm run build && npx wrangler pages deploy dist --project-name=lordsguide`

## Step 6: Push to GitHub (3 minutes)
```bash
git init
git add .
git commit -m "LordsGuide v5.1 — The Miracle Edition ✝"
git remote add origin https://github.com/kjssamsungdev-max/lordsguide.git
git branch -M main
git push -u origin main
```

## Step 7: GitHub Secrets for Auto-Deploy (3 minutes)
Go to GitHub → lordsguide → Settings → Secrets and variables → Actions:
- CLOUDFLARE_API_TOKEN: (Cloudflare Dashboard → My Profile → API Tokens → Create)
- CLOUDFLARE_ACCOUNT_ID: dbaac4c99956159d7594d90033b0224d

Now every push to main auto-deploys. PRs get preview URLs.

## Step 8: Deploy Expansion Pack (10 minutes)
```bash
# Alexa Flash Briefing
cd expansion/alexa && npx wrangler deploy && cd ../..

# Church Bulletin Generator
cd expansion/bulletin-generator && npx wrangler deploy && cd ../..

# Podcast RSS Feed
cd expansion/podcast-worker && npx wrangler deploy && cd ../..

# Telegram Bot
cd expansion/messaging-bot && npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Create bot via @BotFather on Telegram first
# Set webhook: curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://lg-bot.xxx.workers.dev/telegram"
cd ../..

# WordPress Plugin — zip for upload to church sites
cd expansion/wordpress-plugin
zip lordsguide-wordpress.zip lordsguide.php readme.txt
# Upload this zip to any WordPress site → Plugins → Add New → Upload
cd ../..

# Chrome Extension — load for testing
# Open chrome://extensions → Developer mode → Load unpacked → select expansion/chrome-extension/
# To publish: Chrome Web Store Developer Dashboard ($5 one-time fee)
```

## Verification Checklist
- [ ] lordsguide.com loads with daily verse greeting
- [ ] Sign up → Generate a sermon → See results
- [ ] Community tab → Prayer wall works
- [ ] Kids Corner → Bible Story generates
- [ ] Teen Hub → Daily Devo generates
- [ ] Mentorship Bridge → Post and heart
- [ ] Podium mode works
- [ ] Daily Briefing generates
- [ ] Closing prayer (🙏 button) works
- [ ] Language selector changes nav labels
- [ ] Alexa feed: curl your-worker.workers.dev/feed
- [ ] Bulletin: visit your-worker.workers.dev in browser
- [ ] Telegram: send /verse to your bot

## Architecture
```
lordsguide.com (Cloudflare Pages)
    ↓ API calls
lg-api-proxy (Cloudflare Worker) → Anthropic API
    ↑ CORS: lordsguide.com, www.lordsguide.com, localhost

Expansion Workers (all Cloudflare free tier):
  lg-alexa     → /feed (Alexa JSON)
  lg-bulletin  → / (print-ready HTML)
  lg-podcast   → /feed.xml (RSS)
  lg-bot       → /telegram (webhook)
```

## Monthly Cost: $0
Everything runs on Cloudflare free tier (100K requests/day per worker).
The only cost is the Anthropic API key usage for AI generation.
