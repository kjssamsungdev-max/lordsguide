// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Church Bulletin Generator
// Cloudflare Worker that serves a weekly bulletin insert as HTML (print-ready)
//
// Access: https://lg-bulletin.your-subdomain.workers.dev
// Churches visit, customize, and print
// ═══════════════════════════════════════════════════════════════════════════

const VERSES = [
  { text: "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.", ref: "Jeremiah 29:11" },
  { text: "I can do all things through Christ which strengtheneth me.", ref: "Philippians 4:13" },
  { text: "The Lord is my shepherd; I shall not want. He leadeth me beside the still waters. He restoreth my soul.", ref: "Psalm 23:1-3" },
  { text: "Trust in the Lord with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.", ref: "Proverbs 3:5-6" },
  { text: "Be strong and of a good courage; be not afraid, neither be thou dismayed: for the Lord thy God is with thee whithersoever thou goest.", ref: "Joshua 1:9" },
  { text: "And we know that all things work together for good to them that love God, to them who are the called according to his purpose.", ref: "Romans 8:28" },
  { text: "Come unto me, all ye that labour and are heavy laden, and I will give you rest.", ref: "Matthew 11:28" },
  { text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", ref: "John 3:16" },
];

const INSIGHTS = [
  "The original Hebrew word for 'plans' (machashavah) means thoughtful, purposeful design — not chance. God's plans for you are intentional.",
  "The Greek 'ischyō' doesn't mean self-empowerment — it means being strengthened by an external source. Paul's power came from Christ dwelling in him.",
  "In ancient Israel, a shepherd would literally lie across the entrance of the sheepfold at night, becoming the gate with his own body. Jesus is that kind of shepherd.",
  "The Hebrew word for 'trust' (batach) means to throw yourself facedown — complete, vulnerable surrender. This isn't passive trust; it's active abandon.",
  "The phrase 'be strong' (chazaq) was spoken to Joshua as he faced the impossible task of leading Israel into the Promised Land. God speaks it to you now.",
  "The word 'all' in Romans 8:28 is the Greek 'panta' — it truly means everything, without exception. Even the hardest circumstances.",
  "The word 'rest' (anapauō) means more than cessation of work — it means refreshment, restoration, the recovery of strength for the journey ahead.",
  "'Whosoever' — the most inclusive word in all of Scripture. No qualification. No prerequisite. Whoever believes.",
];

function getWeeklyContent() {
  const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (7 * 86400000));
  return {
    verse: VERSES[weekOfYear % VERSES.length],
    insight: INSIGHTS[weekOfYear % INSIGHTS.length],
    week: weekOfYear,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const church = url.searchParams.get('church') || 'Your Church Name';
    const { verse, insight } = getWeeklyContent();
    const today = new Date();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() + (7 - today.getDay()) % 7);
    const dateStr = sunday.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // JSON endpoint for integrations
    if (url.pathname === '/api') {
      return new Response(JSON.stringify({ verse, insight, date: dateStr }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Print-ready HTML bulletin insert
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>LordsGuide Bulletin — ${dateStr}</title>
<link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  @page { size: 5.5in 4.25in; margin: 0; }
  @media print { body { margin: 0; } .no-print { display: none !important; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'DM Sans', sans-serif; color: #2d2416; background: #f5f5f0; }
  .bulletin {
    width: 5.5in; height: 4.25in; padding: 0.35in;
    background: #faf8f4; border: 1px solid #e8e0d4;
    display: flex; flex-direction: column; justify-content: space-between;
    margin: 20px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.08);
  }
  .header { text-align: center; border-bottom: 1px solid #e8e0d4; padding-bottom: 8px; margin-bottom: 8px; }
  .cross { font-size: 18px; color: #8b6914; }
  .church-name { font-family: 'Libre Baskerville', serif; font-size: 11px; color: #2d2416; font-weight: 700; }
  .date { font-size: 8px; color: #8a7e6e; margin-top: 2px; }
  .verse-section { text-align: center; flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .verse-label { font-size: 7px; color: #8b6914; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; margin-bottom: 6px; }
  .verse-text { font-family: 'Libre Baskerville', serif; font-size: 12px; font-style: italic; line-height: 1.7; color: #2d2416; margin-bottom: 6px; }
  .verse-ref { font-size: 9px; color: #8b6914; font-weight: 500; margin-bottom: 10px; }
  .insight { font-size: 9px; color: #8a7e6e; line-height: 1.5; border-top: 1px solid #e8e0d4; padding-top: 8px; }
  .footer { text-align: center; border-top: 1px solid #e8e0d4; padding-top: 6px; display: flex; justify-content: space-between; align-items: center; }
  .qr-text { font-size: 7px; color: #8a7e6e; }
  .powered { font-size: 7px; color: #b5a99a; }
  .controls { text-align: center; padding: 20px; }
  .controls input { padding: 8px 16px; font-size: 14px; border: 1px solid #e8e0d4; border-radius: 8px; margin: 4px; width: 240px; }
  .controls button { padding: 10px 24px; background: #8b6914; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; margin: 4px; }
</style></head><body>

<div class="no-print controls">
  <h2 style="font-family:'Libre Baskerville',serif;color:#2d2416;margin-bottom:8px;">LordsGuide Bulletin Insert</h2>
  <p style="color:#8a7e6e;margin-bottom:12px;">Customize and print for your church bulletin this Sunday.</p>
  <input type="text" id="churchInput" placeholder="Your Church Name" value="${church !== 'Your Church Name' ? church : ''}">
  <button onclick="updateChurch()">Update</button>
  <button onclick="window.print()">🖨 Print</button>
</div>

<div class="bulletin">
  <div class="header">
    <div class="cross">✝</div>
    <div class="church-name" id="churchDisplay">${church}</div>
    <div class="date">${dateStr}</div>
  </div>
  <div class="verse-section">
    <div class="verse-label">This Week's Scripture</div>
    <div class="verse-text">"${verse.text}"</div>
    <div class="verse-ref">— ${verse.ref} KJV</div>
    <div class="insight">💡 ${insight}</div>
  </div>
  <div class="footer">
    <div class="qr-text">📱 lordsguide.com<br>Free sermon prep & Bible study</div>
    <div class="powered">Powered by LordsGuide</div>
  </div>
</div>

<script>
function updateChurch() {
  const name = document.getElementById('churchInput').value || 'Your Church Name';
  document.getElementById('churchDisplay').textContent = name;
}
</script>
</body></html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=3600' },
    });
  }
};
