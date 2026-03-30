# ✝ LordsGuide — Expansion Pack

**6 distribution channels, all deployable today. Zero monthly cost.**

## What's Inside

```
lordsguide-expansion/
├── alexa/                    # Alexa Flash Briefing Feed
│   ├── worker.js             # Cloudflare Worker — Alexa-compatible JSON feed
│   └── wrangler.toml         # Deploy config
│
├── chrome-extension/         # Chrome New Tab Extension
│   ├── manifest.json         # MV3 manifest
│   └── newtab.html           # Daily verse new tab page
│
├── wordpress-plugin/         # WordPress Plugin
│   ├── lordsguide.php        # Plugin file — widget + 3 shortcodes
│   └── readme.txt            # WordPress Plugin Directory readme
│
├── podcast-worker/           # Podcast RSS Feed Generator
│   ├── worker.js             # Cloudflare Worker — valid podcast RSS
│   └── wrangler.toml         # Deploy config
│
├── bulletin-generator/       # Church Bulletin PDF Generator
│   ├── worker.js             # Cloudflare Worker — print-ready HTML
│   └── wrangler.toml         # Deploy config
│
├── messaging-bot/            # Telegram + WhatsApp Bot
│   ├── worker.js             # Cloudflare Worker — Telegram webhook
│   └── wrangler.toml         # Deploy config
│
└── README.md                 # This file
```

## Deploy Guide (all from your phone)

### 1. Alexa Flash Briefing (5 minutes)
```bash
cd alexa && npx wrangler deploy
```
Then go to developer.amazon.com → Alexa Skills Kit → Create Skill → Flash Briefing → Feed URL: your worker URL + `/feed`

### 2. Chrome Extension (10 minutes)
```bash
cd chrome-extension
# Create icons/icon16.png, icon48.png, icon128.png (gold cross on ivory)
# Go to chrome://extensions → Developer mode → Load unpacked → select this folder
# To publish: Chrome Web Store Developer Dashboard → $5 one-time → upload zip
```

### 3. WordPress Plugin (5 minutes)
```bash
cd wordpress-plugin
zip -r lordsguide-wordpress.zip lordsguide.php readme.txt
# Upload zip to any WordPress site → Plugins → Add New → Upload
# Or submit to WordPress Plugin Directory (free, takes 1-2 weeks review)
```
Churches use: `[lordsguide_verse]` shortcode or drag "LordsGuide Daily Verse" widget to sidebar.

### 4. Podcast Feed (5 minutes)
```bash
cd podcast-worker && npx wrangler deploy
```
Submit feed URL to:
- **Spotify**: podcasters.spotify.com
- **Apple Podcasts**: podcastsconnect.apple.com
- **YouTube**: studio.youtube.com → Podcasts
- **Amazon Music**: music.amazon.com/podcasters

### 5. Church Bulletin (5 minutes)
```bash
cd bulletin-generator && npx wrangler deploy
```
Share URL with churches: they visit, type their church name, click Print. Done.

### 6. Telegram Bot (10 minutes)
```bash
cd messaging-bot && npx wrangler deploy
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
Set webhook:
```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://lg-bot.your-subdomain.workers.dev/telegram
```
Bot commands: `/verse` `/prayer` `/both` `/about`

## Cost Summary

| Channel | Setup Cost | Monthly Cost |
|---------|-----------|-------------|
| Alexa Flash Briefing | $0 | $0 |
| Chrome Extension | $5 (one-time) | $0 |
| WordPress Plugin | $0 | $0 |
| Podcast RSS | $0 | $0 |
| Church Bulletin | $0 | $0 |
| Telegram Bot | $0 | $0 |
| **Total** | **$5** | **$0** |

All workers run on Cloudflare Workers free tier (100,000 requests/day).

---
*"Go ye therefore, and teach all nations." — Matthew 28:19 KJV*
