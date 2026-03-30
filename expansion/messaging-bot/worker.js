// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Messaging Bot (Telegram + WhatsApp-ready)
// Cloudflare Worker that handles Telegram webhook for daily verse/prayer
//
// Setup:
// 1. Create a Telegram bot via @BotFather → get token
// 2. npx wrangler secret put TELEGRAM_BOT_TOKEN
// 3. npx wrangler deploy
// 4. Set webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://lg-bot.your-subdomain.workers.dev/telegram
// ═══════════════════════════════════════════════════════════════════════════

const VERSES = [
  { text: "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.", ref: "Jeremiah 29:11" },
  { text: "I can do all things through Christ which strengtheneth me.", ref: "Philippians 4:13" },
  { text: "The Lord is my shepherd; I shall not want.", ref: "Psalm 23:1" },
  { text: "Trust in the Lord with all thine heart; and lean not unto thine own understanding.", ref: "Proverbs 3:5" },
  { text: "Be strong and of a good courage; be not afraid, neither be thou dismayed: for the Lord thy God is with thee.", ref: "Joshua 1:9" },
  { text: "But they that wait upon the Lord shall renew their strength; they shall mount up with wings as eagles.", ref: "Isaiah 40:31" },
  { text: "And we know that all things work together for good to them that love God.", ref: "Romans 8:28" },
  { text: "Come unto me, all ye that labour and are heavy laden, and I will give you rest.", ref: "Matthew 11:28" },
  { text: "The joy of the Lord is your strength.", ref: "Nehemiah 8:10" },
  { text: "He leadeth me beside the still waters. He restoreth my soul.", ref: "Psalm 23:2-3" },
  { text: "Be still, and know that I am God.", ref: "Psalm 46:10" },
  { text: "My grace is sufficient for thee: for my strength is made perfect in weakness.", ref: "2 Corinthians 12:9" },
  { text: "Casting all your care upon him; for he careth for you.", ref: "1 Peter 5:7" },
  { text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", ref: "John 3:16" },
  { text: "Draw nigh to God, and he will draw nigh to you.", ref: "James 4:8" },
  { text: "The name of the Lord is a strong tower: the righteous runneth into it, and is safe.", ref: "Proverbs 18:10" },
];

const PRAYERS = [
  "Lord, thank You for this new day. Guide my steps and use me for Your glory. In Jesus' name, Amen.",
  "Father, fill me with Your peace. Help me trust You in every moment. Amen.",
  "Dear Lord, give me wisdom for today and compassion for everyone I meet. Amen.",
  "Lord Jesus, be my strength, my hope, and my joy today. Amen.",
  "Heavenly Father, I surrender this day to You. Let Your will be done. Amen.",
  "God of grace, open my eyes to see Your hand at work today. In Christ's name, Amen.",
];

function getDailyVerse() {
  const d = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return VERSES[d % VERSES.length];
}
function getDailyPrayer() {
  const d = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return PRAYERS[d % PRAYERS.length];
}

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === '/telegram' && request.method === 'POST') {
      try {
        const update = await request.json();
        const msg = update.message;
        if (!msg || !msg.text) return new Response('ok');

        const chatId = msg.chat.id;
        const text = msg.text.trim().toLowerCase();
        const token = env.TELEGRAM_BOT_TOKEN;

        if (text === '/start') {
          await sendTelegram(token, chatId,
            `✝ <b>Welcome to LordsGuide</b>\n\nI'll send you daily Scripture and prayer.\n\n` +
            `Commands:\n/verse — Today's verse\n/prayer — A prayer for today\n/both — Verse + prayer\n/about — About LordsGuide\n\n` +
            `🌐 Full app: lordsguide.com`
          );
        } else if (text === '/verse') {
          const v = getDailyVerse();
          await sendTelegram(token, chatId,
            `📖 <b>Today's Verse</b>\n\n<i>"${v.text}"</i>\n\n— ${v.ref} KJV\n\n✝ lordsguide.com`
          );
        } else if (text === '/prayer') {
          const pr = getDailyPrayer();
          await sendTelegram(token, chatId, `🙏 <b>Today's Prayer</b>\n\n<i>${pr}</i>\n\n✝ lordsguide.com`);
        } else if (text === '/both') {
          const v = getDailyVerse();
          const pr = getDailyPrayer();
          await sendTelegram(token, chatId,
            `✝ <b>LordsGuide Daily</b>\n\n📖 <i>"${v.text}"</i>\n— ${v.ref}\n\n🙏 <i>${pr}</i>\n\n🌐 lordsguide.com`
          );
        } else if (text === '/about') {
          await sendTelegram(token, chatId,
            `✝ <b>LordsGuide</b> — The Miracle Edition\n\n` +
            `AI-powered sermon prep, Bible study, prayer community, and faith mentorship for all Christians.\n\n` +
            `🎤 Sermon builder\n📖 Live KJV Bible\n🙏 24hr Prayer Map\n🌟 Kids Corner\n🔥 Teen Hub\n🌉 Mentorship Bridge\n📰 Daily Faith Briefing\n🌍 12 languages\n\n` +
            `Every paid subscription gifts a free account to a pastor in need.\n\n` +
            `🌐 lordsguide.com`
          );
        } else {
          const v = getDailyVerse();
          await sendTelegram(token, chatId,
            `📖 <i>"${v.text}"</i>\n— ${v.ref}\n\nType /verse /prayer /both or /about\n✝ lordsguide.com`
          );
        }

        return new Response('ok');
      } catch (e) {
        return new Response('error: ' + e.message, { status: 500 });
      }
    }

    // WhatsApp-ready JSON API (for Twilio/WhatsApp Business integration)
    if (url.pathname === '/api/daily') {
      const v = getDailyVerse();
      const pr = getDailyPrayer();
      return new Response(JSON.stringify({
        verse: v, prayer: pr,
        formatted: `✝ LordsGuide Daily\n\n📖 "${v.text}"\n— ${v.ref} KJV\n\n🙏 ${pr}\n\n🌐 lordsguide.com`,
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Health
    return new Response(JSON.stringify({ status: 'ok', service: 'LordsGuide Messaging Bot', commands: ['/start', '/verse', '/prayer', '/both', '/about'] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
