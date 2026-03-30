// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Podcast RSS Feed Generator
// Serves a valid podcast RSS feed for "The LordsGuide Briefing"
// 
// For full audio generation, integrate with ElevenLabs/Google TTS API
// This worker generates the RSS feed structure + text episodes
//
// Submit this feed URL to: Spotify, Apple Podcasts, YouTube, Amazon Music
// Feed URL: https://lg-podcast.your-subdomain.workers.dev/feed.xml
// ═══════════════════════════════════════════════════════════════════════════

const PODCAST_INFO = {
  title: "The LordsGuide Briefing",
  description: "A 5-minute daily faith briefing — Scripture, inspiring news, and prayer for your morning. Powered by LordsGuide, the AI-powered Bible study and sermon prep platform for all Christians.",
  author: "LordsGuide",
  email: "podcast@lordsguide.com",
  website: "https://lordsguide.com",
  language: "en",
  category: "Religion &amp; Spirituality",
  subcategory: "Christianity",
  image: "https://lordsguide.com/podcast-cover.jpg",
  explicit: "no",
};

const VERSES = [
  { text: "For I know the plans I have for you, declares the Lord.", ref: "Jeremiah 29:11" },
  { text: "I can do all things through Christ which strengtheneth me.", ref: "Philippians 4:13" },
  { text: "The Lord is my shepherd; I shall not want.", ref: "Psalm 23:1" },
  { text: "Trust in the Lord with all thine heart.", ref: "Proverbs 3:5" },
  { text: "Be strong and of a good courage.", ref: "Joshua 1:9" },
  { text: "They that wait upon the Lord shall renew their strength.", ref: "Isaiah 40:31" },
  { text: "All things work together for good to them that love God.", ref: "Romans 8:28" },
  { text: "Come unto me, all ye that labour, and I will give you rest.", ref: "Matthew 11:28" },
  { text: "The joy of the Lord is your strength.", ref: "Nehemiah 8:10" },
  { text: "He leadeth me beside the still waters.", ref: "Psalm 23:2" },
  { text: "Be still, and know that I am God.", ref: "Psalm 46:10" },
  { text: "My grace is sufficient for thee.", ref: "2 Corinthians 12:9" },
  { text: "Casting all your care upon him; for he careth for you.", ref: "1 Peter 5:7" },
  { text: "For God so loved the world.", ref: "John 3:16" },
];

function generateEpisodes(count = 30) {
  const episodes = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const date = new Date(now - i * 86400000);
    const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    const verse = VERSES[dayOfYear % VERSES.length];
    const dateStr = date.toUTCString();
    const dateSlug = date.toISOString().slice(0, 10);

    episodes.push({
      title: `${verse.ref} — ${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
      description: `Today's verse: "${verse.text}" — ${verse.ref} KJV. Open the full briefing with prayer points and sermon tools at lordsguide.com.`,
      pubDate: dateStr,
      guid: `lordsguide-briefing-${dateSlug}`,
      duration: "5:00",
    });
  }
  return episodes;
}

function buildRSS(episodes) {
  const p = PODCAST_INFO;
  const items = episodes.map(ep => `
    <item>
      <title>${ep.title}</title>
      <description><![CDATA[${ep.description}]]></description>
      <pubDate>${ep.pubDate}</pubDate>
      <guid isPermaLink="false">${ep.guid}</guid>
      <itunes:duration>${ep.duration}</itunes:duration>
      <itunes:explicit>${p.explicit}</itunes:explicit>
      <itunes:episodeType>full</itunes:episodeType>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${p.title}</title>
  <description><![CDATA[${p.description}]]></description>
  <link>${p.website}</link>
  <language>${p.language}</language>
  <itunes:author>${p.author}</itunes:author>
  <itunes:owner>
    <itunes:name>${p.author}</itunes:name>
    <itunes:email>${p.email}</itunes:email>
  </itunes:owner>
  <itunes:image href="${p.image}" />
  <itunes:category text="${p.category}">
    <itunes:category text="${p.subcategory}" />
  </itunes:category>
  <itunes:explicit>${p.explicit}</itunes:explicit>
  <atom:link href="https://lg-podcast.workers.dev/feed.xml" rel="self" type="application/rss+xml" />
  ${items}
</channel>
</rss>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/feed.xml' || url.pathname === '/feed') {
      const episodes = generateEpisodes(30);
      const rss = buildRSS(episodes);
      return new Response(rss, {
        headers: {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // JSON endpoint for episode list
    if (url.pathname === '/api/episodes') {
      return new Response(JSON.stringify(generateEpisodes(7)), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify({
      status: 'ok',
      service: 'The LordsGuide Briefing Podcast',
      feed: '/feed.xml',
      note: 'Submit this feed URL to Spotify, Apple Podcasts, YouTube, and Amazon Music',
    }), { headers: { 'Content-Type': 'application/json' } });
  }
};
