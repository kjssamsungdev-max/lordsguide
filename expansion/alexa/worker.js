// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Alexa Flash Briefing Feed
// Cloudflare Worker that serves daily verse + prayer as Alexa-compatible JSON
//
// Deploy: cd alexa && npx wrangler deploy
// Then add this URL as a Flash Briefing feed in the Alexa Developer Console
// ═══════════════════════════════════════════════════════════════════════════

const VERSES = [
  { text: "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.", ref: "Jeremiah 29:11" },
  { text: "I can do all things through Christ which strengtheneth me.", ref: "Philippians 4:13" },
  { text: "The Lord is my shepherd; I shall not want.", ref: "Psalm 23:1" },
  { text: "Trust in the Lord with all thine heart; and lean not unto thine own understanding.", ref: "Proverbs 3:5" },
  { text: "Be strong and of a good courage; be not afraid, neither be thou dismayed: for the Lord thy God is with thee whithersoever thou goest.", ref: "Joshua 1:9" },
  { text: "But they that wait upon the Lord shall renew their strength; they shall mount up with wings as eagles.", ref: "Isaiah 40:31" },
  { text: "And we know that all things work together for good to them that love God.", ref: "Romans 8:28" },
  { text: "The Lord is my light and my salvation; whom shall I fear?", ref: "Psalm 27:1" },
  { text: "Fear thou not; for I am with thee: be not dismayed; for I am thy God.", ref: "Isaiah 41:10" },
  { text: "Delight thyself also in the Lord; and he shall give thee the desires of thine heart.", ref: "Psalm 37:4" },
  { text: "Come unto me, all ye that labour and are heavy laden, and I will give you rest.", ref: "Matthew 11:28" },
  { text: "The joy of the Lord is your strength.", ref: "Nehemiah 8:10" },
  { text: "This is the day which the Lord hath made; we will rejoice and be glad in it.", ref: "Psalm 118:24" },
  { text: "Commit thy way unto the Lord; trust also in him; and he shall bring it to pass.", ref: "Psalm 37:5" },
  { text: "The Lord bless thee, and keep thee: The Lord make his face shine upon thee, and be gracious unto thee.", ref: "Numbers 6:24-25" },
  { text: "He healeth the broken in heart, and bindeth up their wounds.", ref: "Psalm 147:3" },
  { text: "The Lord is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.", ref: "Psalm 34:18" },
  { text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", ref: "John 3:16" },
  { text: "Be still, and know that I am God.", ref: "Psalm 46:10" },
  { text: "The Lord is good, a strong hold in the day of trouble; and he knoweth them that trust in him.", ref: "Nahum 1:7" },
  { text: "Casting all your care upon him; for he careth for you.", ref: "1 Peter 5:7" },
  { text: "He leadeth me beside the still waters. He restoreth my soul.", ref: "Psalm 23:2-3" },
  { text: "For where two or three are gathered together in my name, there am I in the midst of them.", ref: "Matthew 18:20" },
  { text: "In all thy ways acknowledge him, and he shall direct thy paths.", ref: "Proverbs 3:6" },
  { text: "The Lord thy God in the midst of thee is mighty; he will save, he will rejoice over thee with joy.", ref: "Zephaniah 3:17" },
  { text: "Blessed are the peacemakers: for they shall be called the children of God.", ref: "Matthew 5:9" },
  { text: "But the fruit of the Spirit is love, joy, peace, longsuffering, gentleness, goodness, faith.", ref: "Galatians 5:22" },
  { text: "Draw nigh to God, and he will draw nigh to you.", ref: "James 4:8" },
  { text: "The name of the Lord is a strong tower: the righteous runneth into it, and is safe.", ref: "Proverbs 18:10" },
  { text: "Have not I commanded thee? Be strong and of a good courage.", ref: "Joshua 1:9" },
  { text: "My grace is sufficient for thee: for my strength is made perfect in weakness.", ref: "2 Corinthians 12:9" },
];

const PRAYERS = [
  "Lord, thank You for this new day. Guide my steps, guard my heart, and use me for Your glory. In Jesus' name, Amen.",
  "Heavenly Father, fill me with Your peace today. Help me to trust You in every moment. Amen.",
  "Dear Lord, give me wisdom for today's decisions and compassion for everyone I meet. In Christ's name, Amen.",
  "Father God, I surrender this day to You. Let Your will be done in my life. Amen.",
  "Lord Jesus, be my strength when I am weak, my hope when I am discouraged, and my joy in every circumstance. Amen.",
];

function getDailyVerse() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return VERSES[dayOfYear % VERSES.length];
}

function getDailyPrayer() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return PRAYERS[dayOfYear % PRAYERS.length];
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Flash Briefing feed — Alexa-compatible JSON
    if (url.pathname === '/feed' || url.pathname === '/') {
      const verse = getDailyVerse();
      const prayer = getDailyPrayer();
      const today = new Date().toISOString();

      // Alexa Flash Briefing format
      const feed = [
        {
          uid: `lordsguide-verse-${today.slice(0, 10)}`,
          updateDate: today,
          titleText: `LordsGuide — ${verse.ref}`,
          mainText: `Today's verse from ${verse.ref}: ${verse.text} ... ${prayer} ... For the full daily briefing, sermon tools, and community prayer, visit lordsguide.com.`,
          redirectionUrl: "https://lordsguide.com",
        }
      ];

      return new Response(JSON.stringify(feed), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Plain JSON verse endpoint (for other integrations)
    if (url.pathname === '/verse') {
      const verse = getDailyVerse();
      return new Response(JSON.stringify(verse), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Health check
    return new Response(JSON.stringify({ status: 'ok', service: 'LordsGuide Alexa Flash Briefing' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
