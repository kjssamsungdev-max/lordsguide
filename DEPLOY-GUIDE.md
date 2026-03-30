# ✝ LordsGuide — Deployment Guide for Humans
# No jargon. No assumptions. Just follow the steps.

Everything you need to take LordsGuide from a zip file on your
laptop to a live website at lordsguide.com — explained like a friend
sitting next to you walking you through it.

Total time: About 30-45 minutes on your first try.
Total cost: $0 (everything runs on free tiers).

─────────────────────────────────────────────────────────────
BEFORE YOU START — Get These 4 Things Ready
─────────────────────────────────────────────────────────────

1. NODE.JS (the engine that builds your app)
   - Go to: https://nodejs.org
   - Click the big green "LTS" button (the recommended version)
   - Download and install it like any program
   - To check it worked: open Terminal (Mac) or Command Prompt
     (Windows) and type: node -v
   - You should see something like: v20.11.0
   - npm comes with Node automatically

2. GIT (the tool that uploads your code to GitHub)
   - Go to: https://git-scm.com/downloads
   - Download for your laptop (Mac/Windows/Linux)
   - Install with all default settings
   - To check: type in terminal: git --version

3. A FREE GITHUB ACCOUNT (where your code lives online)
   - Go to: https://github.com
   - Click "Sign up" if you don't have one
   - Create a new empty repository called "lordsguide"
     → Click the "+" in the top right → "New repository"
     → Name it: lordsguide
     → Leave everything else as-is
     → Click "Create repository"
   - Don't close this page — you'll need the URL later

4. YOUR ANTHROPIC API KEY (the AI brain behind the sermons)
   - Go to: https://console.anthropic.com
   - Sign up or log in
   - Click "API Keys" in the sidebar
   - Click "Create Key"
   - Copy the key (starts with "sk-ant-...")
   - SAVE IT SOMEWHERE SAFE — you'll need it in Step 3
   - You get $5 of free credit to start

5. YOUR CLOUDFLARE ACCOUNT (already done — you bought lordsguide.com here)
   - Go to: https://dash.cloudflare.com
   - You're already logged in from buying the domain


─────────────────────────────────────────────────────────────
STEP 1: UNZIP THE PACKAGE (2 minutes)
─────────────────────────────────────────────────────────────

Find the file: lordsguide-complete.zip

ON WINDOWS:
  - Right-click the zip file → "Extract All..."
  - Choose where to extract (e.g., your Desktop)
  - Click "Extract"
  - Open the extracted "lordsguide" folder

ON MAC:
  - Double-click the zip file
  - It auto-extracts into a folder
  - Open the folder

You should see these files inside:
  src/               ← the app code
  api-proxy/          ← keeps your API key safe
  expansion/          ← extra channels (Alexa, WordPress, etc.)
  docs/               ← documentation
  public/             ← icons and web config
  package.json        ← list of tools needed
  DEPLOY.md           ← this guide
  README.md           ← technical readme
  ...and more


─────────────────────────────────────────────────────────────
STEP 2: INSTALL THE TOOLS (3 minutes)
─────────────────────────────────────────────────────────────

Open Terminal (Mac) or Command Prompt (Windows).

Navigate to the lordsguide folder. For example:
  cd Desktop/lordsguide

  (If you put it somewhere else, use that path instead)

Now install the tools the app needs:
  npm install

  You'll see a progress bar and lots of text scrolling.
  Wait until it finishes. This downloads React, Vite, etc.
  It creates a "node_modules" folder — don't touch it.

To verify everything is working, run the tests:
  npm test

  You should see: ✅ ALL TESTS PASSED
  If you don't, something went wrong — re-run npm install.


─────────────────────────────────────────────────────────────
STEP 3: DEPLOY THE API PROXY (5 minutes)
─────────────────────────────────────────────────────────────

This is the piece that keeps your Anthropic API key safe.
Without it, anyone could steal your key from the browser.

3a. Log in to Cloudflare from your terminal:
    cd api-proxy
    npx wrangler login

    This opens your browser. Click "Allow" to authorize.
    Come back to the terminal — it should say "Successfully logged in."

3b. Deploy the proxy:
    npx wrangler deploy

    Wait 10-20 seconds. It will print something like:
    "Published lg-api-proxy (1.2 sec)
     https://lg-api-proxy.YOUR-NAME.workers.dev"

    ⭐ WRITE DOWN THIS URL — you need it in Step 5.
    (It's something like: https://lg-api-proxy.kevin123.workers.dev)

3c. Set your Anthropic API key as a secret:
    npx wrangler secret put ANTHROPIC_API_KEY

    It will ask: "Enter a secret value:"
    Paste your API key (the one starting with sk-ant-...)
    Press Enter.
    It should say: "Success!"

    Your key is now safely stored on Cloudflare's servers.
    It is NEVER in your code. Nobody can see it.

3d. Go back to the main folder:
    cd ..


─────────────────────────────────────────────────────────────
STEP 4: BUILD AND DEPLOY THE WEBSITE (5 minutes)
─────────────────────────────────────────────────────────────

4a. Build the app:
    npm run build

    This creates a "dist" folder with the finished website.
    Takes about 10-30 seconds.

4b. Deploy to Cloudflare Pages:
    npx wrangler pages deploy dist --project-name=lordsguide

    First time: it will ask "Create a new project?"
    Type: y and press Enter.

    Wait 30-60 seconds. It will print:
    "Deploying... Success!
     https://lordsguide.pages.dev"

    🎉 YOUR WEBSITE IS LIVE! Visit that URL to see it.
    (It won't have AI working yet — we set that up next)


─────────────────────────────────────────────────────────────
STEP 5: CONNECT THE AI (3 minutes)
─────────────────────────────────────────────────────────────

The app needs to know where the API proxy is.

5a. Open your browser and go to:
    https://dash.cloudflare.com

5b. Click "Compute (Workers)" in the left sidebar

5c. Click "Pages" underneath it

5d. Click on "lordsguide"

5e. Click "Settings" tab at the top

5f. Click "Environment variables" in the left menu

5g. Click "Add variable"

5h. Fill in:
    Variable name: VITE_ANTHROPIC_PROXY_URL
    Value: (paste the URL from Step 3b)
    Example: https://lg-api-proxy.kevin123.workers.dev

5i. Click "Save"

5j. Now redeploy so the app picks up the new variable:
    Go back to your terminal and run:
    npm run build
    npx wrangler pages deploy dist --project-name=lordsguide

    🎉 AI IS NOW CONNECTED! Sermons will generate.


─────────────────────────────────────────────────────────────
STEP 6: CONNECT YOUR DOMAIN (3 minutes)
─────────────────────────────────────────────────────────────

Right now your site is at lordsguide.pages.dev
Let's make it lordsguide.com

6a. In the Cloudflare dashboard, go to:
    Pages → lordsguide → Custom domains

6b. Click "Set up a custom domain"

6c. Type: lordsguide.com

6d. Click "Continue" → "Activate domain"

    Since you bought lordsguide.com through Cloudflare,
    the DNS is set up automatically. No waiting.
    SSL (the padlock icon) is also automatic.

6e. Wait 1-2 minutes, then visit: https://lordsguide.com

    🎉 LORDSGUIDE.COM IS LIVE!


─────────────────────────────────────────────────────────────
STEP 7: PUSH TO GITHUB (3 minutes)
─────────────────────────────────────────────────────────────

This saves your code online and enables auto-deployment.

7a. In your terminal (make sure you're in the lordsguide folder):
    git init
    git add .
    git commit -m "LordsGuide v5.1 — The Miracle Edition"

7b. Connect to your GitHub repository:
    git remote add origin https://github.com/YOUR-USERNAME/lordsguide.git
    git branch -M main
    git push -u origin main

    (Replace YOUR-USERNAME with your GitHub username: kjssamsungdev-max)

    It may ask for your GitHub username and password.
    For the password, you need a Personal Access Token:
    → GitHub → Settings → Developer settings → Personal access tokens
    → Generate new token → Check "repo" → Copy the token
    → Use that as your password

    🎉 YOUR CODE IS SAFELY BACKED UP ON GITHUB!


─────────────────────────────────────────────────────────────
STEP 8: SET UP AUTO-DEPLOY (5 minutes)
─────────────────────────────────────────────────────────────

After this, every time you push code to GitHub,
the website automatically updates. No manual work.

8a. Get a Cloudflare API Token:
    → dash.cloudflare.com
    → Click your profile icon (top right) → "My Profile"
    → Click "API Tokens" in the sidebar
    → Click "Create Token"
    → Click "Use template" next to "Edit Cloudflare Workers"
    → Click "Continue to summary" → "Create Token"
    → COPY THE TOKEN (you only see it once!)

8b. Add secrets to GitHub:
    → Go to github.com/YOUR-USERNAME/lordsguide
    → Click "Settings" tab
    → Click "Secrets and variables" → "Actions" in the sidebar
    → Click "New repository secret"

    Add two secrets:
    Name: CLOUDFLARE_API_TOKEN
    Value: (paste the token from 8a)

    Name: CLOUDFLARE_ACCOUNT_ID
    Value: dbaac4c99956159d7594d90033b0224d

    🎉 AUTO-DEPLOY IS SET UP!
    Now any push to the "main" branch auto-deploys.


─────────────────────────────────────────────────────────────
STEP 9: DEPLOY THE EXPANSION PACK (10 minutes, optional)
─────────────────────────────────────────────────────────────

These are extra channels — do them when you're ready.

ALEXA FLASH BRIEFING:
  cd expansion/alexa
  npx wrangler deploy
  cd ../..
  → Then go to developer.amazon.com → Alexa → Create Skill → Flash Briefing

CHURCH BULLETIN GENERATOR:
  cd expansion/bulletin-generator
  npx wrangler deploy
  cd ../..
  → Share the URL with churches — they visit, type their name, print

PODCAST FEED:
  cd expansion/podcast-worker
  npx wrangler deploy
  cd ../..
  → Submit feed URL to podcasters.spotify.com and podcastsconnect.apple.com

TELEGRAM BOT:
  First create a bot: open Telegram → search @BotFather → send /newbot
  → Follow the prompts → copy the token
  cd expansion/messaging-bot
  npx wrangler deploy
  npx wrangler secret put TELEGRAM_BOT_TOKEN
  → Paste the token
  cd ../..
  → Set webhook (replace TOKEN and URL):
  curl "https://api.telegram.org/botTOKEN/setWebhook?url=https://lg-bot.your-subdomain.workers.dev/telegram"

WORDPRESS PLUGIN:
  cd expansion/wordpress-plugin
  → Upload lordsguide.php to any WordPress site
  → Plugins → Add New → Upload Plugin

CHROME EXTENSION:
  → Open chrome://extensions in Chrome
  → Turn on "Developer mode" (top right toggle)
  → Click "Load unpacked"
  → Select the expansion/chrome-extension folder
  → To publish: Chrome Web Store Developer Dashboard ($5 one-time)


─────────────────────────────────────────────────────────────
YOU'RE DONE! ✝
─────────────────────────────────────────────────────────────

Visit lordsguide.com — it should show:
  ✝ Daily verse greeting
  📰 Daily briefing button
  ⚡ Get Started / Request a Miracle buttons
  🌍 Language picker

Sign up and test:
  → Generate a sermon
  → Open Bible tab
  → Visit Community → Prayer Wall
  → Try Kids Corner and Teen Hub
  → Generate a Daily Briefing
  → End session with 🙏

If something doesn't work:
  → Check the terminal for error messages
  → Make sure VITE_ANTHROPIC_PROXY_URL is set correctly
  → Make sure your Anthropic account has credit
  → Try: npm run build && npx wrangler pages deploy dist --project-name=lordsguide


─────────────────────────────────────────────────────────────
MONTHLY COSTS
─────────────────────────────────────────────────────────────

Cloudflare Pages:     $0 (free tier)
Cloudflare Workers:   $0 (free tier, 100K requests/day)
GitHub:               $0 (free tier)
Anthropic API:        ~$5-50/month depending on usage
Domain renewal:       ~$10/year
Chrome Web Store:     $5 one-time (if you publish the extension)

Total: About $5-50/month, mostly API costs.


─────────────────────────────────────────────────────────────
NEED HELP?
─────────────────────────────────────────────────────────────

The README.md file has technical details.
The docs/ folder has full documentation.
The expansion/README.md explains each extra channel.

"Study to shew thyself approved unto God, a workman
that needeth not to be ashamed, rightly dividing the
word of truth." — 2 Timothy 2:15 KJV

Built with love in Palawan, Philippines.
lordsguide.com ✝
