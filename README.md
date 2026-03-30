# ✝ LordsGuide — The Miracle Edition

**AI-powered sermon prep & Bible study. Every purchase gives the gift of Scripture to someone in need.**

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare)](https://pages.cloudflare.com)
[![Tests](https://img.shields.io/badge/Tests-35%2F35%20passing-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-gold)]()

---

## What Is LordsGuide?

LordsGuide is a mobile-first PWA that gives pastors and believers AI-powered tools for sermon preparation, Bible study, and community prayer — with a unique **buy-one-give-one model** where every paid subscription gifts a free "Miracle" tier to a pastor who can't afford study tools.

### Key Features

- 🎤 **AI Sermon Builder** — Generate 3-point sermon outlines from any passage
- 📖 **Live KJV Bible** — Verse-by-verse reading via bible-api.com
- 📚 **6 Source Types** — Commentary, Lexicon, Compare, Dictionary, Cross-Refs, Devotional
- 📄 **Document Builder** — Tap-to-add blocks, reorder, edit, export
- 📺 **Podium Mode** — Full-screen preaching view with font control + back navigation
- 🙏 **Prayer Power Map** — 24-hour timezone clock, global prayer focuses, community prayer wall
- 📰 **Daily Faith Briefing** — AI-curated news (local/regional/global) with prayer points
- 💡 **Illustration Library** — AI-generated sermon illustrations saved to persistent library
- 🎵 **Worship Song Writer** — AI-generated original worship songs
- 🎮 **Bible Games** — 6 quiz categories with AI-generated questions
- 📅 **Events Board** — Community event posting with reactions
- 👨‍👩‍👧‍👦 **Family Activities** — AI-generated weekly faith activity packs
- 🌍 **12 Languages** — English, Spanish, Tagalog, Portuguese, French, Korean, Chinese, Swahili, Hindi, Arabic, Indonesian, Amharic
- 📴 **Works Offline** — LRU cache with automatic fallback

### The Miracle Model

```
🙏 Someone Asks  →  💛 You Give  →  ✝ They Receive  →  🌊 The Ripple
```

Every Shepherd ($9/mo) subscription gifts a free Miracle account to a pastor in need. The love of giving keeps giving.

---

## Quick Start (Local Development)

```bash
# 1. Clone the repo
git clone https://github.com/kjssamsungdev-max/lordsguide.git
cd lordsguide

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env.local
# Edit .env.local with your proxy URL (see API Proxy section below)

# 4. Run dev server
npm run dev
# Opens at http://localhost:3000

# 5. Run tests
npm test
# 35/35 should pass
```

---

## Deploy to Cloudflare Pages

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- [Anthropic API key](https://console.anthropic.com/)

### Step 1: Deploy the API Proxy (keeps your API key server-side)

```bash
cd api-proxy

# Deploy the Worker
npx wrangler deploy

# Set your Anthropic API key as a secret (never in code!)
npx wrangler secret put ANTHROPIC_API_KEY
# → paste your API key when prompted
```

Your proxy will be live at `https://sf-api-proxy.<your-subdomain>.workers.dev`

### Step 2: Deploy the Frontend

```bash
# Back to project root
cd ..

# Build
npm run build

# Deploy to Cloudflare Pages
npx wrangler pages deploy dist --project-name=lordsguide
```

### Step 3: Set Environment Variables

In [Cloudflare Dashboard](https://dash.cloudflare.com) → Pages → lordsguide → Settings → Environment variables:

| Variable | Value |
|---|---|
| `VITE_ANTHROPIC_PROXY_URL` | `https://sf-api-proxy.<your-subdomain>.workers.dev` |

### Step 4: (Optional) Set up GitHub CI/CD

Add these secrets in GitHub → Settings → Secrets:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → any domain → Overview → right sidebar |

Now every push to `main` auto-deploys. PRs get preview URLs.

---

## Project Structure

```
lordsguide/
├── src/
│   ├── lordsguide.jsx    # Main app (1,779 lines, single-file React)
│   ├── lordsguide.test.js # 35 tests (self-contained runner)
│   └── main.jsx               # React entry point + storage polyfill
├── api-proxy/
│   ├── worker.js              # Cloudflare Worker API proxy
│   └── wrangler.toml          # Worker config
├── public/
│   ├── manifest.json          # PWA manifest
│   ├── favicon.svg            # Gold cross icon
│   ├── _headers               # Security + caching headers
│   ├── _redirects              # SPA fallback
│   └── _routes.json           # Cloudflare routing
├── .github/workflows/
│   └── deploy.yml             # CI/CD: test → build → deploy
├── index.html                 # Vite entry point
├── package.json               # Dependencies + scripts
├── vite.config.js             # Vite build config
├── wrangler.toml              # Cloudflare Pages config
├── .env.example               # Environment variable template
├── .gitignore
├── .nvmrc                     # Node 20
├── LICENSE                    # MIT
└── README.md                  # This file
```

---

## Security

- **API key is NEVER in client code.** All AI calls route through the Cloudflare Worker proxy (`api-proxy/worker.js`)
- **Rate limiting:** 60 requests/minute per IP on the proxy
- **Model allowlist:** Only `claude-sonnet-4` and `claude-haiku-4.5` are permitted
- **Token cap:** `max_tokens` capped at 4,096 to prevent abuse
- **CORS:** Only allowed origins can access the proxy
- **Input sanitization:** 18 sanitize() calls, 14 maxLength attributes
- **Content disclaimers:** AI-generated content has prominent warnings (red alert for lexicon/compare)

---

## Tests

```bash
npm test
```

35 tests across 10 groups: Sanitization (5), Email Validation (3), Passage Validation (4), Sermon Schema (5), Topical Schema (2), Source Schema (3), JSON Parsing (5), LRU Cache (3), Tier Limits (3), Illustration Validation (2).

---

## Architecture Decisions

| Decision | Rationale |
|---|---|
| Single-file React | Solo developer speed. Split into components when team grows. |
| Cloudflare Pages | Free tier, global CDN, Kevin's existing account |
| Worker API proxy | Keep API keys server-side. $0 on Workers free tier (100K req/day) |
| localStorage polyfill | Bridges Claude artifact `window.storage` to standalone deployment |
| LRU cache | Offline fallback without service worker complexity |
| KJV via bible-api.com | Free, open, no API key needed |

---

## Troubleshooting

| Issue | Fix |
|---|---|
| "API 401" errors | Check `ANTHROPIC_API_KEY` secret is set on the Worker |
| Blank page on deploy | Ensure `VITE_ANTHROPIC_PROXY_URL` is set in Pages env vars |
| Tests fail on `isValidPassage` | Ensure regex handles 3-word books (Song of Solomon) |
| Storage not persisting | Check browser localStorage isn't full or disabled |
| Build fails | Run `node -v` — must be 18+ (use `.nvmrc`: 20) |

---

## License

MIT — Kevin / Artisans F&B Corp, Puerto Princesa, Palawan, Philippines

*"Study to shew thyself approved unto God, a workman that needeth not to be ashamed, rightly dividing the word of truth." — 2 Timothy 2:15 KJV*
