import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE v5.1 — Production Build | Cathedral Warmth Edition
// ═══════════════════════════════════════════════════════════════════════════

// ── Error Boundary — prevents white screen on render errors ──
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f4", padding: 32, fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ textAlign: "center", maxWidth: 360 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✝</div>
            <h1 style={{ fontSize: 20, color: "#2d2416", margin: "0 0 8px", fontFamily: "'Libre Baskerville', serif" }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#8a7e6e", margin: "0 0 16px", lineHeight: 1.6 }}>An unexpected error occurred. Please refresh the page to continue.</p>
            <p style={{ fontSize: 11, color: "#b94a48", fontFamily: "monospace", margin: "0 0 16px", wordBreak: "break-all" }}>{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()} style={{ padding: "12px 24px", background: "#8b6914", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Refresh Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const API_MODEL = "claude-sonnet-4-20250514";
const MAX_CACHE = 50;
const INPUT_LIMITS = { passage: 100, topic: 200, sermonBody: 10000, comment: 2000, songReq: 300 };

// ── F7: Input sanitization ──
function sanitize(str, maxLen) {
  if (!str) return "";
  return str.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
}
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Utilities exported for testing in deploy build (see scripture-forge.test.js)

// ── F1: Tier limits & gating ──
const TIER_LIMITS = {
  miracle: { aiCallsPerDay: 10, sourcesPerDay: 10, podium: false, illustrations: false, songsPerDay: 1 },
  shepherd: { aiCallsPerDay: 50, sourcesPerDay: 50, podium: true, illustrations: true, songsPerDay: 20 },
  commission: { aiCallsPerDay: 200, sourcesPerDay: 200, podium: true, illustrations: true, songsPerDay: 100 },
};

function getTodayKey() { return new Date().toISOString().slice(0, 10); }

async function getUsageToday(userId) {
  const key = `sf-usage-${userId}-${getTodayKey()}`;
  try {
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : { aiCalls: 0, sources: 0, songs: 0 };
  } catch { return { aiCalls: 0, sources: 0, songs: 0 }; }
}

async function incrementUsage(userId, field) {
  const key = `sf-usage-${userId}-${getTodayKey()}`;
  const current = await getUsageToday(userId);
  current[field] = (current[field] || 0) + 1;
  try { await window.storage.set(key, JSON.stringify(current)); } catch {}
  return current;
}

// ── F14: Passage format validation ──
function isValidPassage(p) {
  if (!p || p.length < 3) return false;
  // Accept multiple passages: "Romans 8:28, Joshua 14:6-15" or "Romans 8:28; John 3:16"
  // Also accept just a book name like "Psalms" or "Genesis 1"
  const parts = p.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  // Each part should start with a letter or digit (for books like "1 John")
  return parts.every(part => /^(\d\s)?[A-Za-z]+/.test(part));
}

// ── F3: Schema validators ──
function validateSermon(d) {
  if (!d || typeof d !== "object") return { valid: false, msg: "Empty response" };
  if (!d.title) return { valid: false, msg: "Missing sermon title" };
  if (!d.introduction || !d.introduction.hook) return { valid: false, msg: "Missing introduction" };
  if (!Array.isArray(d.points) || d.points.length === 0) return { valid: false, msg: "No sermon points generated" };
  for (let i = 0; i < d.points.length; i++) {
    if (!d.points[i].heading || !d.points[i].explanation) return { valid: false, msg: `Point ${i+1} is incomplete` };
  }
  if (!d.conclusion) return { valid: false, msg: "Missing conclusion" };
  return { valid: true };
}
function validateTopical(d) {
  if (!d || !d.title) return { valid: false, msg: "Missing study title" };
  if (!Array.isArray(d.passages) || d.passages.length === 0) return { valid: false, msg: "No passages found" };
  return { valid: true };
}
function validateSource(type, d) {
  if (!d || typeof d !== "object") return { valid: false, msg: "Empty response" };
  const checks = {
    commentary: () => Array.isArray(d.entries) && d.entries.length > 0,
    lexicon: () => Array.isArray(d.words) && d.words.length > 0,
    compare: () => Array.isArray(d.translations) && d.translations.length > 0,
    dictionary: () => Array.isArray(d.entries) && d.entries.length > 0,
    references: () => Array.isArray(d.groups) && d.groups.length > 0,
    devotional: () => d.theme && d.reflection,
  };
  if (checks[type] && !checks[type]()) return { valid: false, msg: `Incomplete ${type} data` };
  return { valid: true };
}
function validateIllustrations(d) {
  if (!d || !Array.isArray(d.illustrations) || d.illustrations.length === 0) return { valid: false, msg: "No illustrations generated" };
  return { valid: true };
}

// ── AI call with retry ──
const API_URL = "https://lg-api-proxy.kjssamsungdev.workers.dev";

async function callClaude(sys, usr, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: API_MODEL, max_tokens: 4000, system: sys, messages: [{ role: "user", content: usr }] }),
      });
      if (!r.ok) throw new Error(`API ${r.status}: ${r.statusText}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      const text = d.content?.map(b => b.text || "").join("\n") || "";
      if (!text) throw new Error("Empty response from AI");
      return text;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function parseAIJSON(raw) {
  // Step 1: Clean markdown fencing
  let cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  // Step 2: Try direct parse
  try { return JSON.parse(cleaned); } catch (e1) {
    // Step 3: Try extracting JSON from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (e2) { /* fall through */ }
    }
    // Step 4: Try fixing common AI JSON errors (trailing commas, single quotes)
    try {
      const fixed = cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]").replace(/'/g, '"');
      const m2 = fixed.match(/\{[\s\S]*\}/);
      if (m2) return JSON.parse(m2[0]);
    } catch { /* fall through */ }
    // Step 5: Give up with clear message
    throw new Error("AI returned malformed data. Please try again — responses vary each time.");
  }
}

// ── Bible text (free API) ──
// ── Bible Versions — free/public domain translations ──
const BIBLE_VERSIONS = [
  { id: "kjv", name: "King James Version", abbr: "KJV", year: 1611, style: "Formal", api: "bible-api", tradition: "Protestant" },
  { id: "web", name: "World English Bible", abbr: "WEB", year: 2000, style: "Modern", api: "bible-api", tradition: "All" },
  { id: "asv", name: "American Standard", abbr: "ASV", year: 1901, style: "Literal", api: "bolls", tradition: "Protestant" },
  { id: "bbe", name: "Bible in Basic English", abbr: "BBE", year: 1965, style: "Simple", api: "bible-api", tradition: "All" },
  { id: "darby", name: "Darby Translation", abbr: "DARBY", year: 1890, style: "Literal", api: "bolls", tradition: "Protestant" },
  { id: "ylt", name: "Young's Literal", abbr: "YLT", year: 1862, style: "Ultra-literal", api: "bolls", tradition: "Protestant" },
  { id: "oeb-us", name: "Open English Bible (US)", abbr: "OEB", year: 2010, style: "Modern", api: "bible-api", tradition: "All" },
  { id: "clementine", name: "Clementine Vulgate", abbr: "VULG", year: 1592, style: "Latin", api: "bible-api", tradition: "Catholic" },
  { id: "almeida", name: "Almeida (Portuguese)", abbr: "ALM", year: 1819, style: "Portuguese", api: "bible-api", tradition: "All" },
  { id: "rccv", name: "Romanian Cornilescu", abbr: "RCCV", year: 1924, style: "Romanian", api: "bible-api", tradition: "All" },
];

async function fetchBibleText(ref, version = "kjv") {
  const v = BIBLE_VERSIONS.find(b => b.id === version) || BIBLE_VERSIONS[0];
  try {
    // bible-api.com supports: kjv, web, bbe, oeb-us, clementine, almeida, rccv
    const url = `https://bible-api.com/${encodeURIComponent(ref)}?translation=${v.id}`;
    const r = await fetch(url);
    if (!r.ok) return { text: `Could not fetch: ${ref} (${r.status})`, ref, verses: [], error: true, version: v.abbr };
    const d = await r.json();
    if (d.error) return { text: `Not found: ${ref}`, ref, verses: [], error: true, version: v.abbr };
    return { text: d.text, ref: d.reference, verses: d.verses || [], error: false, version: v.abbr };
  } catch { return { text: `Could not fetch: ${ref}. Check connection.`, ref, verses: [], error: true, version: v.abbr }; }
}

// ── F8: LRU Cache with timestamps ──
function lruEvict(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE) return cache;
  entries.sort((a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0));
  const evictCount = entries.length - MAX_CACHE;
  const keep = Object.fromEntries(entries.slice(evictCount));
  return keep;
}

// ── Storage helpers ──
async function store(key, val) {
  try { await window.storage.set(key, JSON.stringify(val)); } catch {}
}
async function load(key, fallback) {
  try {
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : fallback;
  } catch { return fallback; }
}
// ── F2: Atomic shared storage with per-item reaction keys ──
async function sharedLoad(key, fallback) {
  try {
    const r = await window.storage.get(key, true);
    return r ? JSON.parse(r.value) : fallback;
  } catch { return fallback; }
}
async function sharedSave(key, data) {
  try { await window.storage.set(key, JSON.stringify(data), true); return true; } catch { return false; }
}
async function sharedAtomicUpdate(key, updateFn, fallback = []) {
  // Re-read fresh from storage right before write to minimize race window
  const current = await sharedLoad(key, fallback);
  const updated = updateFn(current);
  return await sharedSave(key, updated);
}
// Per-item atomic reactions — each sermon's reactions stored separately to prevent full-array races
async function atomicReact(sermonId, reactionType) {
  const key = `sf-react-${sermonId}`;
  const current = await sharedLoad(key, { love: 0, pray: 0, amen: 0 });
  current[reactionType] = (current[reactionType] || 0) + 1;
  await sharedSave(key, current);
  return current;
}
async function loadReactions(sermonId) {
  return await sharedLoad(`sf-react-${sermonId}`, { love: 0, pray: 0, amen: 0 });
}

// ── AI Prompts ──
const P = {
  sermon: `You are an expert homiletics professor. Generate a sermon outline in ONLY valid JSON (no markdown, no backticks):
{"title":"...","big_idea":"...","introduction":{"hook":"...","context":"...","thesis":"..."},"points":[{"heading":"...","verses":"...","explanation":"...","illustration":"...","application":"..."}],"conclusion":{"summary":"...","call":"...","closing":"..."},"cross_refs":["..."],"key_words":[{"word":"...","meaning":"..."}],"questions":["..."]}
3 points. Theologically sound, practically applicable.`,
  topical: `You are a systematic theology scholar. Build a topical study in ONLY valid JSON (no markdown):
{"title":"...","definition":"...","passages":[{"ref":"...","testament":"OT|NT","teaching":"...","insight":"..."}],"misconceptions":[{"myth":"...","truth":"..."}],"applications":[{"situation":"...","principle":"...","action":"..."}],"key_verses":["..."]}
6 passages, 3 misconceptions, 3 applications.`,
  commentary: `Bible commentary engine. Provide AI-generated commentary inspired by classic commentators. Return ONLY JSON: {"entries":[{"verse":"...","text":"...","source":"AI-inspired"}]} 5-7 entries.`,
  lexicon: `Biblical lexicon. Provide AI-generated word studies. Note: Strong's numbers should be verified by user. Return ONLY JSON: {"words":[{"english":"...","original":"...","transliteration":"...","strongs":"...","definition":"...","theological_significance":"..."}]} 5 words.`,
  compare: `Bible translation comparison. NOTE: These are AI-recalled approximations — users should verify against published translations. Return ONLY JSON: {"key_verse":"...","translations":[{"version":"...","text":"...","note":"..."}]} Use KJV, NKJV, ESV, NIV, NASB.`,
  dictionary: `Bible dictionary. Return ONLY JSON: {"entries":[{"term":"...","category":"person|place|custom|object","definition":"...","related_passages":["..."]}]} 4-5 entries.`,
  references: `Cross-reference engine. Return ONLY JSON: {"groups":[{"theme":"...","refs":[{"ref":"...","connection":"..."}]}]} 2-3 groups, 3-4 refs each.`,
  devotional: `Devotional writer. Return ONLY JSON: {"theme":"...","reflection":"...","prayer":"...","takeaway":"..."}`,
  illustration: `Sermon illustration expert. Generate 6 illustrations. Return ONLY JSON: {"illustrations":[{"title":"...","type":"story|analogy|quote|historical|real_life|object_lesson","content":"...","source":"Attribution or Original","best_for":"...","scripture_tie":"..."}]}`,
  song: `Christian worship songwriter. Return ONLY JSON: {"title":"...","theme":"...","verses":[{"label":"Verse 1","lines":["..."]},{"label":"Chorus","lines":["..."]}],"scripture_inspiration":"...","suggested_style":"..."}. 2 verses and 1 chorus.`,
  quiz: `Bible quiz master. Return ONLY JSON: {"title":"...","questions":[{"q":"...","options":["A","B","C","D"],"answer":0,"fun_fact":"..."}]}. 7 questions, answer is 0-indexed.`,
  family: `Christian family coordinator. Return ONLY JSON: {"theme":"...","memory_verse":{"ref":"...","text":"..."},"activities":[{"title":"...","type":"game|craft|devotion|service|cooking|outdoor","ages":"...","duration":"...","description":"...","supplies":"...","faith_connection":"..."}],"discussion_starters":["..."],"prayer_focus":"..."}. 5 activities.`,
};

// ── Constants ──
const SOURCES = [
  { id: "commentary", label: "Commentary", icon: "📖", color: "#f59e0b" },
  { id: "lexicon", label: "Lexicon", icon: "🔤", color: "#a78bfa" },
  { id: "compare", label: "Bible Compare", icon: "📊", color: "#3b82f6" },
  { id: "dictionary", label: "Dictionary", icon: "📕", color: "#ef4444" },
  { id: "references", label: "Cross Refs", icon: "⛓️", color: "#06b6d4" },
  { id: "devotional", label: "Devotional", icon: "🕊️", color: "#22c55e" },
];
const TOPICS = ["Marriage & Family","Suffering & Trials","Faith & Doubt","Leadership","Justice & Mercy","Prayer","Forgiveness","Identity in Christ","The Holy Spirit","Anxiety & Peace","Stewardship","Evangelism","Work & Calling","Community","End Times","Custom..."];
const TIERS = [
  { id: "miracle", name: "The Miracle", price: "Free", desc: "For those who need it most", color: "#22c55e", features: ["AI sermon outlines (3/week)","Bible text access","Document builder","1 source type/day","Given by a brother or sister in Christ"] },
  { id: "shepherd", name: "The Shepherd", price: "$9/mo", desc: "For pastors & study leaders", color: "#c9a84c", features: ["Unlimited AI analysis","All 6 source types","Podium/Preach mode","Clipboard export","Your purchase gifts a Miracle tier"] },
  { id: "commission", name: "The Great Commission", price: "$19/mo", desc: "For churches & teams", color: "#5b8def", features: ["Everything in Shepherd","5 team seats","Shared sermon library","Priority AI","Your purchase gifts 3 Miracle tiers"] },
];
const C = {
  // Warm light palette — cathedral warmth, parchment softness
  bg: "#faf8f4",         // warm ivory parchment
  surface: "#f3efe8",    // slightly deeper parchment
  card: "#ffffff",       // pure white cards
  border: "#e8e0d4",     // warm sand border
  gold: "#8b6914",       // deep liturgical gold
  goldL: "#b8860b",      // warm gold text
  blue: "#2c5f8a",       // scripture blue (deep, trustworthy)
  green: "#3d7a4f",      // olive green (life, growth)
  red: "#b94a48",        // communion wine red
  purple: "#6b4c8a",     // royal purple (Lent, Advent)
  text: "#2d2416",       // warm dark brown (not pure black)
  dim: "#8a7e6e",        // warm gray
  miracle: "#3d7a4f",    // same olive green for miracle
  accent: "#d4a84b",     // bright gold accent
  warm: "#f5ede0",       // warm highlight background
};

// ── Inspirational Greetings ──
const INSPIRATIONAL_QUOTES = [
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
  { text: "Commit thy way unto the Lord; trust also in him; and he shall bring it to pass.", ref: "Psalm 37:5" },
  { text: "This is the day which the Lord hath made; we will rejoice and be glad in it.", ref: "Psalm 118:24" },
];

const SESSION_PRAYERS = [
  "Heavenly Father, thank You for this time in Your Word. May what was studied today take root in hearts and bear fruit for Your Kingdom. In Jesus' name, Amen.",
  "Lord, bless the one who studied today. Give them wisdom to apply Your truth and courage to share it with others. In Your precious name, Amen.",
  "Father God, we commit this study to You. Let Your Holy Spirit illuminate every truth and guide every sermon that flows from this time. Amen.",
  "Dear Lord, thank You for the gift of Scripture. May the words prepared today bring hope, healing, and transformation to every listener. In Christ's name, Amen.",
  "Gracious God, seal this time of study with Your blessing. Protect the message, anoint the messenger, and prepare the hearts of those who will hear. Amen.",
  "Lord Jesus, You are the Living Word. As we close this session, we ask that Your Spirit continue to teach, convict, and encourage through what was prepared today. Amen.",
];

function getDailyQuote() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,0).getTime()) / 86400000);
  return INSPIRATIONAL_QUOTES[dayOfYear % INSPIRATIONAL_QUOTES.length];
}
function getSessionPrayer() {
  return SESSION_PRAYERS[Math.floor(Math.random() * SESSION_PRAYERS.length)];
}

// ── Multi-Language Support ──
const LANGUAGES = [
  { code: "en", name: "English", native: "English", dir: "ltr" },
  { code: "es", name: "Spanish", native: "Español", dir: "ltr" },
  { code: "tl", name: "Tagalog", native: "Tagalog", dir: "ltr" },
  { code: "pt", name: "Portuguese", native: "Português", dir: "ltr" },
  { code: "fr", name: "French", native: "Français", dir: "ltr" },
  { code: "ko", name: "Korean", native: "한국어", dir: "ltr" },
  { code: "zh", name: "Chinese", native: "中文", dir: "ltr" },
  { code: "sw", name: "Swahili", native: "Kiswahili", dir: "ltr" },
  { code: "hi", name: "Hindi", native: "हिन्दी", dir: "ltr" },
  { code: "ar", name: "Arabic", native: "العربية", dir: "rtl" },
  { code: "id", name: "Indonesian", native: "Bahasa", dir: "ltr" },
  { code: "am", name: "Amharic", native: "አማርኛ", dir: "ltr" },
];

// Core UI strings for translation
const UI_STRINGS = {
  en: { study: "Prepare", bible: "Bible", sources: "Tools", shared: "Community", doc: "My Sermon", generate: "Generate Sermon", welcome: "Welcome", signIn: "Sign in to start", offline: "Offline", prayer: "Prayer", closingPrayer: "Closing Prayer" },
  es: { study: "Estudio", bible: "Biblia", sources: "Fuentes", shared: "Comunidad", doc: "Doc", generate: "Generar Sermón", welcome: "Bienvenido", signIn: "Inicia sesión", offline: "Sin conexión", prayer: "Oración", closingPrayer: "Oración Final" },
  tl: { study: "Pag-aaral", bible: "Bibliya", sources: "Pinagmulan", shared: "Ibinahagi", doc: "Doc", generate: "Gumawa ng Sermon", welcome: "Maligayang pagdating", signIn: "Mag-sign in", offline: "Offline", prayer: "Panalangin", closingPrayer: "Pangwakas na Panalangin" },
  pt: { study: "Estudo", bible: "Bíblia", sources: "Fontes", shared: "Comunidade", doc: "Doc", generate: "Gerar Sermão", welcome: "Bem-vindo", signIn: "Entre para começar", offline: "Offline", prayer: "Oração", closingPrayer: "Oração Final" },
  fr: { study: "Étude", bible: "Bible", sources: "Sources", shared: "Communauté", doc: "Doc", generate: "Générer Sermon", welcome: "Bienvenue", signIn: "Connectez-vous", offline: "Hors ligne", prayer: "Prière", closingPrayer: "Prière de Clôture" },
  ko: { study: "학습", bible: "성경", sources: "자료", shared: "공유", doc: "문서", generate: "설교 생성", welcome: "환영합니다", signIn: "로그인", offline: "오프라인", prayer: "기도", closingPrayer: "마무리 기도" },
  zh: { study: "学习", bible: "圣经", sources: "资料", shared: "社区", doc: "文档", generate: "生成讲道", welcome: "欢迎", signIn: "登录开始", offline: "离线", prayer: "祷告", closingPrayer: "结束祷告" },
  sw: { study: "Somo", bible: "Biblia", sources: "Vyanzo", shared: "Shiriki", doc: "Hati", generate: "Tengeneza Hotuba", welcome: "Karibu", signIn: "Ingia kuanza", offline: "Nje ya mtandao", prayer: "Sala", closingPrayer: "Sala ya Kufunga" },
  hi: { study: "अध्ययन", bible: "बाइबिल", sources: "स्रोत", shared: "साझा", doc: "दस्तावेज़", generate: "उपदेश बनाएं", welcome: "स्वागत", signIn: "शुरू करने के लिए साइन इन करें", offline: "ऑफ़लाइन", prayer: "प्रार्थना", closingPrayer: "समापन प्रार्थना" },
  ar: { study: "دراسة", bible: "الكتاب المقدس", sources: "مصادر", shared: "مشترك", doc: "مستند", generate: "إنشاء عظة", welcome: "مرحبا", signIn: "سجل دخولك للبدء", offline: "غير متصل", prayer: "صلاة", closingPrayer: "صلاة الختام" },
  id: { study: "Studi", bible: "Alkitab", sources: "Sumber", shared: "Berbagi", doc: "Dok", generate: "Buat Khotbah", welcome: "Selamat datang", signIn: "Masuk untuk memulai", offline: "Offline", prayer: "Doa", closingPrayer: "Doa Penutup" },
  am: { study: "ጥናት", bible: "መጽሐፍ ቅዱስ", sources: "ምንጮች", shared: "የተጋራ", doc: "ሰነድ", generate: "ስብከት ፍጠር", welcome: "እንኳን ደህና መጡ", signIn: "ለመጀመር ይግቡ", offline: "ከመስመር ውጪ", prayer: "ጸሎት", closingPrayer: "የመዝጊያ ጸሎት" },
};
const GAME_CATS = [
  { id: "heroes", icon: "⚔️", name: "Bible Heroes", desc: "Great men and women of faith" },
  { id: "books", icon: "📚", name: "Books of the Bible", desc: "How well do you know the 66?" },
  { id: "parables", icon: "🌾", name: "Parables of Jesus", desc: "Identify the parable" },
  { id: "geography", icon: "🗺️", name: "Bible Geography", desc: "Where did it happen?" },
  { id: "numbers", icon: "🔢", name: "Bible Numbers", desc: "How many? How old?" },
  { id: "prophecy", icon: "🔮", name: "Prophecy", desc: "Match prophecy to fulfillment" },
];
const EVENT_TYPES = [
  { id: "worship", label: "🎵 Worship Night", color: "#a78bfa" },
  { id: "study", label: "📖 Bible Study", color: "#c9a84c" },
  { id: "youth", label: "🧑‍🤝‍🧑 Youth", color: "#22c55e" },
  { id: "family", label: "👨‍👩‍👧‍👦 Family", color: "#5b8def" },
  { id: "outreach", label: "🌍 Outreach", color: "#f59e0b" },
  { id: "prayer", label: "🙏 Prayer", color: "#f87171" },
];
const CHARITY_CAUSES = [
  { id: "bibles", icon: "📖", name: "Bibles for All", desc: "Scripture access for unreached communities", goal: 500, color: "#c9a84c" },
  { id: "seminary", icon: "🎓", name: "Seminary Scholarships", desc: "Training for aspiring pastors", goal: 1000, color: "#5b8def" },
  { id: "orphans", icon: "🏠", name: "Orphan Care", desc: "Support orphanages worldwide", goal: 750, color: "#f87171" },
  { id: "water", icon: "💧", name: "Living Water Wells", desc: "Clean water for communities", goal: 2000, color: C.blue },
  { id: "missions", icon: "✈️", name: "Mission Trips", desc: "Send missionaries to unreached", goal: 1500, color: "#22c55e" },
];
const MENTOR_ROLES = [
  { id: "pastor", icon: "🎤", title: "Pastor / Preacher" },
  { id: "worship", icon: "🎵", title: "Worship Leader" },
  { id: "youth", icon: "🧑‍🤝‍🧑", title: "Youth Ministry" },
  { id: "marriage", icon: "💍", title: "Marriage & Family" },
  { id: "business", icon: "💼", title: "Faith in Business" },
];

// ── Prayer categories & global causes ──
const PRAYER_CATEGORIES = [
  { id: "all", label: "🌍 All", color: "#c9a84c" },
  { id: "personal", label: "🙏 Personal", color: "#a78bfa" },
  { id: "healing", label: "💊 Healing", color: "#f87171" },
  { id: "nations", label: "🌎 Nations", color: "#5b8def" },
  { id: "peace", label: "🕊️ Peace", color: "#22c55e" },
  { id: "church", label: "⛪ Church", color: "#f59e0b" },
  { id: "family", label: "👨‍👩‍👧‍👦 Family", color: C.blue },
  { id: "provision", label: "🍞 Provision", color: "#c9a84c" },
  { id: "urgent", label: "🔴 Urgent", color: "#ef4444" },
];

const GLOBAL_PRAYER_FOCUSES = [
  { id: "persecuted", icon: "⛓️", title: "Persecuted Church", desc: "Christians facing persecution in 60+ nations", region: "Middle East & Asia", verse: "Hebrews 13:3", color: "#f87171" },
  { id: "unreached", icon: "🌍", title: "Unreached Peoples", desc: "3.2 billion people with no access to the Gospel", region: "10/40 Window", verse: "Romans 10:14", color: "#f59e0b" },
  { id: "orphans", icon: "🏠", title: "Orphans & Vulnerable", desc: "140 million orphans worldwide", region: "Global", verse: "James 1:27", color: "#5b8def" },
  { id: "leaders", icon: "🏛️", title: "World Leaders", desc: "Wisdom and righteousness for those in authority", region: "Every Nation", verse: "1 Timothy 2:1-2", color: "#a78bfa" },
  { id: "revival", icon: "🔥", title: "Spiritual Revival", desc: "An awakening in the hearts of all people", region: "Global", verse: "2 Chronicles 7:14", color: "#22c55e" },
  { id: "disasters", icon: "🆘", title: "Natural Disasters", desc: "Communities recovering from earthquakes, floods, storms", region: "Active Zones", verse: "Psalm 46:1", color: "#ef4444" },
  { id: "youth", icon: "🧑‍🤝‍🧑", title: "Next Generation", desc: "Young people finding faith and purpose", region: "Every School", verse: "Psalm 71:17", color: C.blue },
  { id: "unity", icon: "🤝", title: "Church Unity", desc: "One body, many parts — unity across denominations", region: "Global Body", verse: "John 17:21", color: "#c9a84c" },
];

// Time zones for the 24-hour prayer clock world map
const PRAYER_ZONES = [
  { name: "Pacific Islands", offset: 12, emoji: "🌊", lat: -15, prayers: 0 },
  { name: "New Zealand", offset: 12, emoji: "🇳🇿", lat: -41, prayers: 0 },
  { name: "Australia", offset: 10, emoji: "🇦🇺", lat: -25, prayers: 0 },
  { name: "Japan / Korea", offset: 9, emoji: "🇯🇵", lat: 36, prayers: 0 },
  { name: "Philippines", offset: 8, emoji: "🇵🇭", lat: 13, prayers: 0 },
  { name: "India", offset: 5.5, emoji: "🇮🇳", lat: 21, prayers: 0 },
  { name: "East Africa", offset: 3, emoji: "🌍", lat: -1, prayers: 0 },
  { name: "Europe", offset: 1, emoji: "🇪🇺", lat: 48, prayers: 0 },
  { name: "UK / West Africa", offset: 0, emoji: "🇬🇧", lat: 52, prayers: 0 },
  { name: "Brazil", offset: -3, emoji: "🇧🇷", lat: -15, prayers: 0 },
  { name: "US East", offset: -5, emoji: "🇺🇸", lat: 40, prayers: 0 },
  { name: "US West / Mexico", offset: -8, emoji: "🌎", lat: 34, prayers: 0 },
];

// ── F4: AI Disclaimer component — prominent, context-specific ──
function AIDisclaimer({ type }) {
  const warnings = {
    lexicon: "⚠ Strong's numbers and definitions are AI-generated approximations. Verify against a published concordance (e.g. Blue Letter Bible) before citing in sermons.",
    compare: "⚠ Translation texts are AI-recalled, NOT from licensed Bible publishers. Always verify against an official copy of ESV, NIV, NASB before quoting.",
    commentary: "⚠ Commentary insights are AI-inspired, not directly from published commentators. Cross-check with actual Matthew Henry, Gill, or Barnes texts.",
    default: "⚠ AI-generated study aid — verify against published sources before citing in sermons or teaching."
  };
  const msg = warnings[type] || warnings.default;
  const isHighRisk = type === "lexicon" || type === "compare" || type === "commentary";
  return (
    <div role="alert" style={{
      background: isHighRisk ? "#7f1d1d15" : "#1e293b",
      border: `1px solid ${isHighRisk ? "#f8717140" : "#334155"}`,
      borderRadius: 8, padding: "8px 10px", margin: "8px 0", display: "flex", gap: 6, alignItems: "flex-start"
    }}>
      <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{isHighRisk ? "🔴" : "⚠"}</span>
      <p style={{ fontSize: 10, color: isHighRisk ? "#fca5a5" : "#94a3b8", margin: 0, lineHeight: 1.5 }}>{msg}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
function AppInner() {
  // ── F1: Auth state ──
  const [user, setUser] = useState(null); // { name, email, tier: miracle|shepherd|commission }
  const [authScreen, setAuthScreen] = useState(null); // null|login|signup|miracle-request
  const [authForm, setAuthForm] = useState({ name: "", email: "", tier: "miracle" });

  // Nav
  const [screen, setScreen] = useState("landing");
  const [passage, setPassage] = useState("Joshua 14:6-15");
  const [passageError, setPassageError] = useState(null); // F14
  const [bibleText, setBibleText] = useState(null);
  const [bibleVersion, setBibleVersion] = useState("kjv");
  const [compareVersion, setCompareVersion] = useState(null); // null = off, "web" etc = side-by-side
  const [compareText, setCompareText] = useState(null);
  const [wordStudy, setWordStudy] = useState(null); // { word, verseRef } for tap-a-word

  // Study
  const [studyMode, setStudyMode] = useState(null);
  const [topic, setTopic] = useState(null);
  const [customTopic, setCustomTopic] = useState("");
  const [showScriptureFinder, setShowScriptureFinder] = useState(false);
  const [scriptureFindQuery, setScriptureFindQuery] = useState("");
  const [scriptureFindResults, setScriptureFindResults] = useState([]);
  const [selectedSources, setSelectedSources] = useState([]);
  const [sermonContext, setSermonContext] = useState("");
  const [compiledSermon, setCompiledSermon] = useState(null);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [result, setResult] = useState(null);
  const [resultType, setResultType] = useState(null);

  // Sources
  const [activeSource, setActiveSource] = useState(null);
  const [sourceResult, setSourceResult] = useState(null);

  // Document
  const [docBlocks, setDocBlocks] = useState([]);
  const [docTitle, setDocTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [undoBlock, setUndoBlock] = useState(null); // F12: undo

  // ── F6: Per-operation loading ──
  const [loadingOps, setLoadingOps] = useState({});
  const setLoading = (op, val) => setLoadingOps(p => ({ ...p, [op]: val }));
  const isLoading = (op) => !!loadingOps[op];
  const anyLoading = Object.values(loadingOps).some(Boolean);

  // Errors with retry
  const [error, setError] = useState(null);
  const [lastFailedOp, setLastFailedOp] = useState(null); // F11: retry
  const [toast, setToast] = useState(null);
  const [miracleCount, setMiracleCount] = useState(0);
  const [showBlessingModal, setShowBlessingModal] = useState(null); // null | "giver" | "receiver"
  const [blessingData, setBlessingData] = useState({ giverName: "", receiverCount: 0, tier: "" });
  const [podiumFontSize, setPodiumFontSize] = useState(28);
  const [podiumSection, setPodiumSection] = useState(0);

  // Community
  const [sermons, setSermons] = useState([]);
  const [shareMode, setShareMode] = useState(null);
  const [viewSermon, setViewSermon] = useState(null);
  const [shareForm, setShareForm] = useState({ author: "", church: "", title: "", passage: "", body: "", tags: [] });
  const [commentText, setCommentText] = useState("");
  const [communityFilter, setCommunityFilter] = useState("recent");

  // Hub tabs
  const [hubTab, setHubTab] = useState("prayer");
  const [songRequest, setSongRequest] = useState("");
  const [songResult, setSongResult] = useState(null);
  const [musicMode, setMusicMode] = useState("write");
  const [worshipPlanQuery, setWorshipPlanQuery] = useState("");
  const [worshipStyle, setWorshipStyle] = useState("contemporary");
  const [worshipPlan, setWorshipPlan] = useState(null);
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [discoverResult, setDiscoverResult] = useState(null);
  const [mediaMode, setMediaMode] = useState("explore");
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaResult, setMediaResult] = useState(null);
  const [gameState, setGameState] = useState({ active: null, score: 0, qIdx: 0, answers: [], quizData: null });
  const [gameMode, setGameMode] = useState("quiz"); // "quiz" | "generator" | "sworddrill"
  const [generatedGame, setGeneratedGame] = useState(null);
  const [gameConfig, setGameConfig] = useState({ ageGroup: "teens", groupSize: "10-20", space: "indoor", topic: "" });
  const [events, setEvents] = useState([]);
  const [eventForm, setEventForm] = useState({ title: "", type: "", date: "", desc: "" });
  const [showEventForm, setShowEventForm] = useState(false);
  const [familyActivities, setFamilyActivities] = useState(null);

  // Prayer Power Map
  const [prayers, setPrayers] = useState([]);
  const [prayerForm, setPrayerForm] = useState({ text: "", category: "personal", name: "", urgent: false });
  const [showPrayerForm, setShowPrayerForm] = useState(false);
  const [prayerFilter, setPrayerFilter] = useState("all");
  const [activePrayerCount, setActivePrayerCount] = useState(0);
  const [prayerMapTime, setPrayerMapTime] = useState(new Date());

  // Language + Session
  const [lang, setLang] = useState("en");
  const [showClosingPrayer, setShowClosingPrayer] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const t = UI_STRINGS[lang] || UI_STRINGS.en;
  const dailyQuote = useMemo(() => getDailyQuote(), []);

  // Daily Briefing / News
  const [briefing, setBriefing] = useState(null);
  const [briefingPrefs, setBriefingPrefs] = useState({ local: "", region: "", interests: [], showOnOpen: true });
  const [showBriefing, setShowBriefing] = useState(false);
  const [showBriefingSetup, setShowBriefingSetup] = useState(false);

  // Kids & Teens Corner
  const [kidsMode, setKidsMode] = useState(null); // null | story | quiz | memory | craft
  const [kidsResult, setKidsResult] = useState(null);
  const [kidsAgeGroup, setKidsAgeGroup] = useState("6-9");

  // Teen Hub — Mentorship Bridge
  const [teenMode, setTeenMode] = useState(null); // null | devotion | challenge | mentor | discuss | journal | serve
  const [teenResult, setTeenResult] = useState(null);
  const [mentorPosts, setMentorPosts] = useState([]);
  const [mentorForm, setMentorForm] = useState({ text: "", type: "teen-to-kid", name: "" });
  const [showMentorForm, setShowMentorForm] = useState(false);

  // Offline + Cache + Illustrations
  const [isOnline, setIsOnline] = useState(true);
  const [cache, setCache] = useState({});
  const [illustrations, setIllustrations] = useState([]);
  const [illusSearch, setIllusSearch] = useState("");
  const [illusResult, setIllusResult] = useState(null);
  const [illusCategory, setIllusCategory] = useState("all");

  // ── Persistence ──
  useEffect(() => {
    (async () => {
      const [savedBlocks, savedTitle, savedCache, savedIllus] = await Promise.all([
        load("sf-doc-blocks", []), load("sf-doc-title", ""), load("sf-cache", {}), load("sf-illustrations", []),
      ]);
      if (savedBlocks.length) setDocBlocks(savedBlocks);
      if (savedTitle) setDocTitle(savedTitle);
      if (savedCache && Object.keys(savedCache).length) setCache(savedCache);
      if (savedIllus?.length) setIllustrations(savedIllus);
      // Shared data
      const [shSermons, shEvents, shMiracles, savedUser] = await Promise.all([
        sharedLoad("sf-sermons", []), sharedLoad("sf-events", []),
        sharedLoad("sf-miracle-count", { count: 0 }), load("sf-user", null),
      ]);
      setSermons(shSermons); setEvents(shEvents);
      setMiracleCount(shMiracles?.count || 0);
      if (savedUser) setUser(savedUser);
      // Load saved language
      const savedLang = await load("sf-lang", "en");
      if (savedLang && LANGUAGES.find(l => l.code === savedLang)) setLang(savedLang);
      // Load briefing preferences
      const savedBriefPrefs = await load("sf-briefing-prefs", null);
      if (savedBriefPrefs) setBriefingPrefs(savedBriefPrefs);
    })();
  }, []);

  useEffect(() => { store("sf-doc-blocks", docBlocks); }, [docBlocks]);
  useEffect(() => { store("sf-doc-title", docTitle); }, [docTitle]);

  // ── Offline detection ──
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => { setIsOnline(false); setToast("📴 Offline — cached content available"); };
    window.addEventListener("online", on); window.addEventListener("offline", off);
    setIsOnline(navigator.onLine !== false);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // ── Toast with auto-clear ──
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.duration || 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg, opts = {}) => setToast({ msg, ...opts });

  // ── F8: LRU Cache ──
  const cacheSet = useCallback(async (key, data) => {
    setCache(prev => {
      const updated = { ...prev, [key]: { data, lastAccessed: Date.now(), created: Date.now() } };
      const evicted = lruEvict(updated);
      store("sf-cache", evicted);
      return evicted;
    });
  }, []);
  const cacheGet = useCallback((key) => {
    const entry = cache[key];
    if (!entry) return null;
    // Update lastAccessed (LRU touch)
    setCache(prev => {
      const updated = { ...prev, [key]: { ...prev[key], lastAccessed: Date.now() } };
      store("sf-cache", updated);
      return updated;
    });
    return entry.data;
  }, [cache]);

  // ── F1: Auth functions with real gating ──
  const [usage, setUsage] = useState({ aiCalls: 0, sources: 0, songs: 0 });

  // Load usage on user change
  useEffect(() => {
    if (!user?.email) return;
    (async () => { const u = await getUsageToday(user.email); setUsage(u); })();
  }, [user?.email]);

  // ── Stripe Payment URL (set via env var or default) ──
  const PAYMENT_URL = typeof window !== 'undefined' && window.__LORDSGUIDE_PAYMENT_URL__
    ? window.__LORDSGUIDE_PAYMENT_URL__
    : "https://lg-payments.workers.dev";

  const login = async () => {
    const email = sanitize(authForm.email, 200);
    if (!email || !isValidEmail(email)) { showToast("Please enter a valid email"); return; }
    try {
      // Paid tiers → redirect to Stripe Checkout
      if (authForm.tier === "shepherd" || authForm.tier === "commission") {
        setLoading("checkout", true);
        try {
          const res = await fetch(`${PAYMENT_URL}/create-checkout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tier: authForm.tier,
              email,
              name: sanitize(authForm.name, 100) || "Beloved",
              successUrl: window.location.origin + "?payment=success&tier=" + authForm.tier + "&email=" + encodeURIComponent(email) + "&name=" + encodeURIComponent(sanitize(authForm.name, 100) || "Beloved"),
              cancelUrl: window.location.origin + "?payment=cancelled",
            }),
          });
          const data = await res.json();
          if (data.url) {
            window.location.href = data.url; // Redirect to Stripe
            return;
          } else {
            showToast("Payment setup failed — " + (data.error || "please try again"));
          }
        } catch(e) { showToast("Could not connect to payment system — please try again"); }
        finally { setLoading("checkout", false); }
        return;
      }

      // Free Miracle tier → instant signup (no payment)
      const u = { name: sanitize(authForm.name, 100) || "Beloved", email, tier: authForm.tier, createdAt: new Date().toISOString() };
      setUser(u); store("sf-user", u); setAuthScreen(null);
      showToast(`Welcome, ${u.name}!`);
      // Show onboarding for first-time users
      if (!localStorage.getItem("lg-onboarded")) { setTimeout(() => setShowOnboarding(true), 2500); localStorage.setItem("lg-onboarded", "1"); }
      if (u.tier === "miracle") {
        await sharedAtomicUpdate("sf-miracle-count", prev => ({ count: (prev?.count || 0) + 1 }), { count: 0 });
        setMiracleCount(p => p + 1);
        setTimeout(() => {
          setBlessingData({ giverName: "", receiverCount: 0, tier: "miracle" });
          setShowBlessingModal("receiver");
        }, 1500);
      }
      const usg = await getUsageToday(email);
      setUsage(usg);
    } catch(e) { showToast("Sign in error — please try again"); }
  };

  // ── Handle Stripe return (payment=success in URL) ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      const tier = params.get("tier") || "shepherd";
      const email = params.get("email") || "";
      const name = params.get("name") || "Beloved";
      const gifted = tier === "commission" ? 3 : 1;
      const u = { name: decodeURIComponent(name), email: decodeURIComponent(email), tier, createdAt: new Date().toISOString() };
      setUser(u); store("sf-user", u); setAuthScreen(null);
      showToast(`Welcome, ${u.name}! Thank you for your gift.`);
      // Increment miracle counter
      sharedAtomicUpdate("sf-miracle-count", prev => ({ count: (prev?.count || 0) + gifted }), { count: 0 }).then(() => setMiracleCount(p => p + gifted));
      // Show giver blessing modal
      setTimeout(() => {
        setBlessingData({ giverName: u.name, receiverCount: gifted, tier });
        setShowBlessingModal("giver");
      }, 2000);
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("payment") === "cancelled") {
      showToast("Payment cancelled — you can try again anytime");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const logout = () => { setUser(null); store("sf-user", null); setScreen("landing"); showToast("Signed out"); };

  const canAccess = (feature) => {
    if (!user) return false;
    const limits = TIER_LIMITS[user.tier] || TIER_LIMITS.miracle;
    switch (feature) {
      case "ai": return usage.aiCalls < limits.aiCallsPerDay;
      case "source": return usage.sources < limits.sourcesPerDay;
      case "podium": return limits.podium;
      case "illustrations": return limits.illustrations;
      case "song": return usage.songs < limits.songsPerDay;
      case "basic": return true;
      default: return true;
    }
  };

  const checkAndTrack = async (feature) => {
    if (!user) { setAuthScreen("signup"); return false; }
    try {
      const fieldMap = { ai: "aiCalls", source: "sources", song: "songs" };
      const field = fieldMap[feature];
      if (!field) return canAccess(feature);
      if (!canAccess(feature)) {
        const limits = TIER_LIMITS[user.tier];
        const limitVal = feature === "ai" ? limits.aiCallsPerDay : feature === "source" ? limits.sourcesPerDay : limits.songsPerDay;
        showToast(`Daily limit reached (${limitVal}/${limitVal}). Upgrade for more.`);
        return false;
      }
      const updated = await incrementUsage(user.email, field);
      setUsage(updated);
      return true;
    } catch(e) { return true; } // fail open — don't block user on tracking error
  };

  // ── F12: Doc helpers with undo ──
  const addToDoc = useCallback((type, label, content) => {
    setDocBlocks(p => [...p, { id: Date.now(), type, label, content, ts: new Date().toLocaleTimeString() }]);
    showToast(`✓ Added: ${label}`);
  }, []);
  const removeBlock = (id) => {
    const block = docBlocks.find(b => b.id === id);
    setDocBlocks(p => p.filter(b => b.id !== id));
    setUndoBlock(block);
    setToast({ msg: "Block removed", action: "Undo", onAction: () => { setDocBlocks(p => [...p, block]); setUndoBlock(null); }, duration: 5000 });
  };
  const moveBlock = (id, dir) => setDocBlocks(p => {
    const i = p.findIndex(b => b.id === id);
    if ((dir < 0 && i === 0) || (dir > 0 && i === p.length - 1)) return p;
    const a = [...p]; [a[i], a[i + dir]] = [a[i + dir], a[i]]; return a;
  });
  const saveEdit = id => { setDocBlocks(p => p.map(b => b.id === id ? { ...b, content: editText } : b)); setEditingId(null); };

  // ── F14: Passage validation ──
  const validatePassage = (p) => {
    if (!p?.trim()) { setPassageError("Enter a passage"); return false; }
    if (!isValidPassage(p)) { setPassageError("Format: Book Chapter:Verse (e.g. John 3:16)"); return false; }
    setPassageError(null); return true;
  };

  // ── Community helpers ──
  const loadSermons = async () => { try { const s = await sharedLoad("sf-sermons", []); setSermons(s); } catch(e) { console.error("loadSermons:", e); } };
  const publishSermon = async () => {
    if (!shareForm.title || !shareForm.body || isLoading("publish")) return;
    setLoading("publish", true);
    try {
    const sermon = {
      id: `s_${Date.now()}`, author: sanitize(shareForm.author, 100) || user?.name || "A Servant of God",
      church: sanitize(shareForm.church, 100), title: sanitize(shareForm.title, 200),
      passage: sanitize(shareForm.passage, INPUT_LIMITS.passage),
      body: sanitize(shareForm.body, INPUT_LIMITS.sermonBody), tags: shareForm.tags.slice(0, 5),
      timestamp: new Date().toISOString(),
      displayDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      reactions: { love: 0, pray: 0, amen: 0 }, comments: [],
    };
    await sharedAtomicUpdate("sf-sermons", prev => [sermon, ...prev].slice(0, 100));
    setSermons(prev => [sermon, ...prev].slice(0, 100));
    setShareForm({ author: "", church: "", title: "", passage: "", body: "", tags: [] });
    setShareMode(null); showToast("🕊️ Sermon shared!");
    } catch(e) { setError(e.message); } finally { setLoading("publish", false); }
  };
  const reactToSermon = async (sid, type) => {
    try {
    const newReactions = await atomicReact(sid, type);
    setSermons(prev => prev.map(s => s.id === sid ? { ...s, reactions: newReactions } : s));
    if (viewSermon?.id === sid) setViewSermon(prev => ({ ...prev, reactions: newReactions }));
    } catch(e) { console.error("reactToSermon:", e); }
  };
  const addComment = async (sid) => {
    const text = sanitize(commentText, INPUT_LIMITS.comment);
    if (!text) return;
    try {
    const comment = { id: `c_${Date.now()}`, text, date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }), author: user?.name || "Anonymous" };
    await sharedAtomicUpdate("sf-sermons", prev =>
      prev.map(s => s.id === sid ? { ...s, comments: [...(s.comments || []), comment] } : s)
    );
    setSermons(prev => prev.map(s => s.id === sid ? { ...s, comments: [...(s.comments || []), comment] } : s));
    if (viewSermon?.id === sid) setViewSermon(prev => ({ ...prev, comments: [...(prev.comments || []), comment] }));
    setCommentText(""); showToast("💬 Comment added!");
    } catch(e) { setError(e.message); }
  };
  const sortedSermons = useMemo(() => [...sermons].sort((a, b) => {
    if (communityFilter === "loved") return ((b.reactions?.love||0)+(b.reactions?.amen||0)) - ((a.reactions?.love||0)+(a.reactions?.amen||0));
    if (communityFilter === "prayedfor") return (b.reactions?.pray||0) - (a.reactions?.pray||0);
    return new Date(b.timestamp) - new Date(a.timestamp);
  }), [sermons, communityFilter]);

  // ── Bible fetch with cache ──
  const loadBible = async (ref, ver) => {
    const r = ref || passage;
    const v = ver || bibleVersion;
    if (!validatePassage(r)) return;
    setLoading("bible", true); setWordStudy(null);
    try {
      const passages = r.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
      const cacheKey = `bible_${r}_${v}`;
      const cached = cacheGet(cacheKey);
      if (cached) { setBibleText(cached); } else {
        if (passages.length === 1) {
          const data = await fetchBibleText(passages[0], v);
          setBibleText(data);
          if (!data.error) cacheSet(cacheKey, data);
        } else {
          const results = await Promise.all(passages.map(p => fetchBibleText(p, v)));
          const combined = { ref: results.map(d => d.ref).join(' | '), text: results.map(d => d.text).join('\n\n'), verses: results.flatMap(d => d.verses || []), error: results.every(d => d.error), multi: true, version: BIBLE_VERSIONS.find(b=>b.id===v)?.abbr || "KJV" };
          setBibleText(combined);
          if (!combined.error) cacheSet(cacheKey, combined);
        }
      }
      // Load comparison text if comparison mode is active
      if (compareVersion && compareVersion !== v) {
        const compKey = `bible_${r}_${compareVersion}`;
        const compCached = cacheGet(compKey);
        if (compCached) { setCompareText(compCached); } else {
          if (passages.length === 1) {
            const data = await fetchBibleText(passages[0], compareVersion);
            setCompareText(data);
            if (!data.error) cacheSet(compKey, data);
          } else {
            const results = await Promise.all(passages.map(p => fetchBibleText(p, compareVersion)));
            const combined = { ref: results.map(d => d.ref).join(' | '), text: results.map(d => d.text).join('\n\n'), verses: results.flatMap(d => d.verses || []), error: results.every(d => d.error), multi: true, version: BIBLE_VERSIONS.find(b=>b.id===compareVersion)?.abbr };
            setCompareText(combined);
            if (!combined.error) cacheSet(compKey, combined);
          }
        }
      } else { setCompareText(null); }
    } catch(e) { setError("Failed to load Bible text: " + e.message); } finally { setLoading("bible", false); }
  };

  // ── Word Study — tap a word to see Greek/Hebrew definition ──
  const studyWord = async (word, verseRef) => {
    if (!(await checkAndTrack("ai"))) return;
    setWordStudy({ word, loading: true, data: null });
    try {
      const raw = await callClaude(
        `You are a Biblical language scholar. Given a word from a Bible verse, provide its original language study. Return ONLY valid JSON: {"word":"${word}","original":"Greek or Hebrew word","transliteration":"transliterated form","strongs":"Strong's number (e.g. G26 or H430)","language":"Greek or Hebrew","definition":"concise definition","root":"root word if applicable","usage":"how it's used in this context","theological":"theological significance in 1-2 sentences","other_occurrences":["2-3 other notable verses using this word"]}`,
        `Word: "${word}"\nFrom verse: ${verseRef}\nBible version: ${bibleVersion.toUpperCase()}\nProvide the original Greek or Hebrew word study.`
      );
      const parsed = parseAIJSON(raw);
      setWordStudy({ word, loading: false, data: parsed });
    } catch(e) { setWordStudy({ word, loading: false, data: null, error: e.message }); }
  };

  // ── F3+F11: AI generation with validation + retry ──
  // ── AI Compile Sermon — reads all doc blocks and produces a preachable sermon ──
  const compileSermon = async () => {
    if (docBlocks.length < 2) { showToast("Add at least 2 notes first"); return; }
    if (!(await checkAndTrack("ai"))) return;
    setLoading("compile", true); setCompiledSermon(null);
    try {
      const notes = docBlocks.map((b, i) => `[${b.label}]: ${b.content}`).join("\n\n");
      const ctx = sermonContext ? `\nPreaching context: ${sanitize(sermonContext, 300)}` : "";
      const raw = await callClaude(
        `You are an expert sermon writer. You will receive a pastor's collected study notes — Scripture passages, commentary excerpts, cross-references, personal reflections, and other materials. Your job is to compile these notes into a complete, preachable sermon.\n\nWrite the sermon as flowing prose — NOT JSON. Include:\n1. A compelling opening (hook the congregation)\n2. Clear introduction of the theme\n3. 2-3 main points with Scripture references woven in\n4. Illustrations and applications from the notes\n5. A powerful conclusion with a call to action\n6. A brief closing prayer\n\nWrite in a warm, pastoral tone. The sermon should be 800-1200 words — about 10-15 minutes of preaching. Use the pastor's own notes and reflections where possible.`,
        `Here are my study notes for this sermon:\n\nPassage(s): ${sanitize(passage, 300)}${ctx}\nTitle: ${docTitle || "Untitled"}\n\n${notes}`
      );
      setCompiledSermon(raw);
      showToast("✝ Sermon compiled!");
    } catch(e) { setError("Compile failed: " + e.message); }
    finally { setLoading("compile", false); }
  };

  // ── Scripture Finder — describe what you need, get passage suggestions ──
  const findScripture = async () => {
    if (!scriptureFindQuery.trim()) return;
    if (!(await checkAndTrack("ai"))) return;
    setLoading("findScripture", true);
    try {
      const raw = await callClaude(
        `You are a Bible scholar. Given a description of what someone is trying to articulate or a theme they want to preach about, suggest 5 relevant Bible passages. Return ONLY valid JSON: {"suggestions":[{"ref":"e.g. Romans 8:28","summary":"Brief 1-sentence description of why this passage fits"}]}`,
        `I'm looking for Scripture about: ${sanitize(scriptureFindQuery, 200)}`
      );
      const parsed = parseAIJSON(raw);
      if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        setScriptureFindResults(parsed.suggestions.slice(0, 5));
      } else {
        showToast("Couldn't find passages — try rephrasing");
      }
    } catch(e) { showToast("Scripture search failed — " + e.message); }
    finally { setLoading("findScripture", false); }
  };

  const generate = async () => {
    if (!validatePassage(passage)) return;
    if (!(await checkAndTrack("ai"))) return;
    const op = "generate"; const cacheKey = `gen_${studyMode}_${passage}_${topic||""}_${sermonContext||""}`;
    // Offline fallback
    const cached = cacheGet(cacheKey);
    if (!isOnline && cached) { setResult(cached); setResultType(studyMode); setScreen("results"); showToast("📴 From cache"); return; }
    setLoading(op, true); setError(null);
    try {
      const p = sanitize(passage, 300);
      const ctx = sermonContext ? `\nContext/Direction: ${sanitize(sermonContext, 300)}` : "";
      let raw;
      if (studyMode === "sermon") { raw = await callClaude(P.sermon, `Passage(s): ${p}${ctx}\nStyle: expository`); }
      else { const t = topic === "Custom..." ? sanitize(customTopic, INPUT_LIMITS.topic) : topic; raw = await callClaude(P.topical, `Topic: ${t}\nPassage(s): ${p}${ctx}`); }
      const parsed = parseAIJSON(raw);
      const v = studyMode === "sermon" ? validateSermon(parsed) : validateTopical(parsed);
      if (!v.valid) throw new Error(`Incomplete result: ${v.msg}. Please retry.`);
      setResult(parsed); setResultType(studyMode); setScreen("results"); cacheSet(cacheKey, parsed);
    } catch (e) {
      if (cached) { setResult(cached); setResultType(studyMode); setScreen("results"); showToast("📴 Showing cached (generation failed)"); }
      else { setError(e.message); setLastFailedOp(() => generate); }
    } finally { setLoading(op, false); }
  };

  const fetchSource = async (id) => {
    if (!(await checkAndTrack("source"))) return;
    const cacheKey = `src_${id}_${passage}`;
    setActiveSource(id); setSourceResult(null); setLoading("source", true); setError(null);
    const cached = cacheGet(cacheKey);
    if (!isOnline && cached) { setSourceResult(cached); setLoading("source", false); showToast("📴 From cache"); return; }
    try {
      const raw = await callClaude(P[id], `Passage: ${sanitize(passage, INPUT_LIMITS.passage)}`);
      const parsed = parseAIJSON(raw);
      const v = validateSource(id, parsed); if (!v.valid) throw new Error(v.msg);
      setSourceResult(parsed); cacheSet(cacheKey, parsed);
    } catch (e) {
      if (cached) { setSourceResult(cached); showToast("📴 Cached"); }
      else { setError(e.message); setLastFailedOp(() => () => fetchSource(id)); }
    } finally { setLoading("source", false); }
  };

  const generateIllustrations = async (q) => {
    if (!(await checkAndTrack("ai"))) return;
    const query = sanitize(q, INPUT_LIMITS.songReq); if (!query) return;
    setLoading("illus", true); setError(null);
    try {
      const raw = await callClaude(P.illustration, `Topic/Scripture: ${query}`);
      const parsed = parseAIJSON(raw);
      const v = validateIllustrations(parsed); if (!v.valid) throw new Error(v.msg);
      setIllusResult(parsed);
      const newIllus = parsed.illustrations.map(il => ({ ...il, id: `il_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, query, savedAt: new Date().toLocaleDateString() }));
      const updated = [...newIllus, ...illustrations].slice(0, 200);
      setIllustrations(updated); store("sf-illustrations", updated);
    } catch (e) { setError(e.message); } finally { setLoading("illus", false); }
  };

  const generateSong = async () => {
    if (!(await checkAndTrack("song"))) return;
    const q = sanitize(songRequest, INPUT_LIMITS.songReq); if (!q) return;
    setLoading("song", true); setError(null);
    try { const raw = await callClaude(P.song, q); setSongResult(parseAIJSON(raw)); }
    catch (e) { setError(e.message); } finally { setLoading("song", false); }
  };

  // ── Worship Set Planner ──
  const generateWorshipPlan = async () => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("worshipPlan", true); setWorshipPlan(null);
    try {
      const raw = await callClaude(
        `You are a worship leader with 15 years of experience planning services for churches of all sizes and traditions. Generate a complete worship set list matched to a sermon theme. Include REAL songs by REAL artists that exist on Spotify. Return ONLY valid JSON:
{"theme":"Worship theme","style":"${worshipStyle}","duration":"Total estimated time","set_list":[{"title":"Real song name","artist":"Real artist name","moment":"opening|praise|worship|response|communion|offering|closing","key":"Musical key","tempo":"Slow|Medium|Fast","scripture_connection":"How this song connects to the sermon passage","why":"Why this song fits here in the flow"}],"flow_notes":"How the set flows emotionally — energy arc from opening to closing","prayer_transitions":["Transition prayer/reading between songs 1-2","Between songs 3-4"],"spotify_playlist_name":"Suggested Spotify playlist name"}
Include 5-7 songs. Mix well-known songs with hidden gems. Include artists from different traditions and eras.`,
        `Sermon topic: ${sanitize(worshipPlanQuery, 300)}\nStyle: ${worshipStyle}\nSuggest real songs by real Christian artists. Include modern worship (Hillsong, Elevation, Bethel, Maverick City, Housefires, CityAlight), classic hymns (reimagined versions too), gospel (Kirk Franklin, Tasha Cobbs), and indie/alternative Christian artists.`
      );
      setWorshipPlan(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("worshipPlan", false); }
  };

  // ── Discover Christian Music ──
  const discoverMusic = async () => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("discover", true); setDiscoverResult(null);
    try {
      const raw = await callClaude(
        `You are a Christian music curator who knows every genre — from traditional hymns to CCM, worship, gospel, Christian hip-hop, indie folk worship, Celtic Christian (like Iona Community), Christian rock, and global worship music. Recommend REAL songs and artists. Return ONLY valid JSON:
{"mood":"${discoverQuery}","recommendations":[{"song":"Real song title","artist":"Real artist name","emoji":"🎵","genre":"Worship|Gospel|CCM|Hymn|Indie|Hip-Hop|Folk|Rock|Global","mood":"Uplifting|Contemplative|Energetic|Peaceful|Powerful|Intimate","scripture_vibe":"A verse this song echoes","why_listen":"1 sentence on why this song is special"}],"playlist_idea":"A name and description for a Spotify playlist with these songs","deep_cut":"One lesser-known artist or song most people haven't heard but should"}
Recommend 8-10 songs. Mix mainstream and underground. Include at least one hymn, one gospel song, one modern worship song, and one unexpected pick.`,
        `I'm looking for: ${sanitize(discoverQuery, 200)}`
      );
      setDiscoverResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("discover", false); }
  };

  // ── Media & Learn — videos, virtual tours, courses, sermon visuals ──
  const generateMedia = async (mode, query) => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("media", true); setMediaResult(null);
    const prompts = {
      explore: `You are a Christian media curator and Biblical studies professor. Given a topic, recommend the best free Christian media content available online. Return ONLY valid JSON:
{"topic":"${query}","documentaries":[{"title":"Real documentary/series name","platform":"YouTube|Netflix|Amazon|Free on web","creator":"Channel or production company","year":"Year","duration":"Runtime","description":"1-2 sentence description","url_hint":"YouTube search term to find it","scripture_connection":"Related passage"}],"youtube_channels":[{"name":"Real channel name","subscribers":"Approximate subscribers","focus":"What they cover","best_video":"Their most popular/relevant video title","url_hint":"Search term"}],"podcasts":[{"name":"Real podcast name","host":"Host name","platform":"Spotify|Apple|YouTube","episode_suggestion":"A specific episode relevant to this topic"}],"learning_path":"A suggested 5-step learning journey combining these resources"}`,

      tour: `You are a Biblical archaeologist and historian who leads virtual tours of Biblical sites. Given a location or passage, create an immersive virtual tour guide. Return ONLY valid JSON:
{"location":"${query}","modern_name":"Modern country/city name","coordinates":"Approximate lat,lng","era":"Historical period","bible_references":[{"ref":"Scripture reference","event":"What happened here"}],"tour_stops":[{"stop":"Stop name","description":"What you see here — describe it vividly as if walking through","historical_note":"Archaeological or historical fact","scripture":"Relevant verse","visual_note":"What this would look like — for the mind's eye"}],"travel_tip":"If someone actually visited today — what to know","google_earth_search":"Search term for Google Earth to see this location","artifacts":"Notable archaeological finds from this location","prayer":"A prayer to pray at this sacred place"}`,

      course: `You are a seminary professor designing a free mini-course for self-study. Create a complete 5-lesson course on the given topic. Return ONLY valid JSON:
{"course_title":"${query}","description":"Course description","level":"Beginner|Intermediate|Advanced","duration":"Total estimated study time","lessons":[{"lesson_number":1,"title":"Lesson title","objective":"What the student will learn","key_passage":"Primary Scripture for this lesson","reading":"Suggested Bible reading (chapter or section)","content":"3-4 paragraph teaching summary — the actual lesson content","discussion_questions":["Question 1","Question 2","Question 3"],"practical_application":"One thing to do this week","video_suggestion":"A real YouTube video or lecture to watch (give search term)"}],"final_project":"A capstone assignment to demonstrate understanding","certificate_verse":"A verse to memorize upon completion","next_steps":"What to study next after this course"}`,

      visuals: `You are a sermon presentation designer. Given a sermon topic, create a complete visual plan for sermon slides and media. Return ONLY valid JSON:
{"sermon_topic":"${query}","title_slide":{"title":"Sermon title","subtitle":"Scripture reference","visual":"Description of ideal background image/mood","color_scheme":"Suggested colors"},"slides":[{"slide_number":1,"heading":"Slide heading","content":"Key point or verse to display","visual_note":"What image or visual to use","speaker_note":"What the preacher says during this slide"}],"video_moments":[{"moment":"Where in the sermon to play a video","suggestion":"Description of ideal video clip","youtube_search":"Search term to find it on YouTube","duration":"Suggested length"}],"closing_slide":{"text":"Call to action or prayer","visual":"Closing visual description"},"presentation_tips":"Tips for visual preaching"}`,
    };
    try {
      const raw = await callClaude(prompts[mode] || prompts.explore, `Topic: ${sanitize(query, 300)}. Be specific with real content that actually exists. Include real YouTube channels, real documentaries, real courses.`);
      setMediaResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("media", false); }
  };

  const startQuiz = async (cat) => {
    setLoading("quiz", true);
    try { const raw = await callClaude(P.quiz, `Category: ${cat}. Fun and challenging.`); const d = parseAIJSON(raw); setGameState({ active: cat, score: 0, qIdx: 0, answers: [], quizData: d }); }
    catch (e) { setError(e.message); } finally { setLoading("quiz", false); }
  };

  const answerQuiz = (oi) => {
    const correct = oi === gameState.quizData.questions[gameState.qIdx].answer;
    const na = [...gameState.answers, { chosen: oi, correct }];
    const ns = gameState.score + (correct ? 1 : 0);
    setGameState(g => ({ ...g, qIdx: g.qIdx + 1, score: ns, answers: na }));
  };

  // ── Game Generator — custom youth group / team building games ──
  const generateGame = async (type) => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("gameGen", true); setGeneratedGame(null);
    const ages = { kids: "ages 4-12", teens: "ages 13-18", adults: "adults 18+", mixed: "mixed ages (kids, teens, and adults together)" };
    try {
      const raw = await callClaude(
        `You are an expert youth pastor and team building facilitator with 20 years of experience running church games, camps, retreats, and team building events. Generate a creative, fun ${type} game. Return ONLY valid JSON:
{"name":"Creative game name","type":"${type}","emoji":"🎯","age_group":"${gameConfig.ageGroup}","group_size":"${gameConfig.groupSize}","space":"${gameConfig.space}","duration":"estimated time","energy_level":"Low|Medium|High","materials":["list of materials needed, or 'None' if no materials"],"scripture_tie":"A Bible verse or principle this game reinforces","setup":"How to set up the game (2-3 sentences)","rules":["Step 1: ...","Step 2: ...","Step 3: ...","Step 4: ...","Step 5: ..."],"variations":["Variation 1 for different group sizes","Variation 2 for different ages"],"debrief":["Discussion question 1 connecting game to faith","Discussion question 2","Discussion question 3"],"leader_tip":"One pro tip for the leader running this game"}`,
        `Generate a ${type} game for ${ages[gameConfig.ageGroup] || "teens"}, group size ${gameConfig.groupSize}, ${gameConfig.space} setting.${gameConfig.topic ? ` Connect to sermon topic: ${gameConfig.topic}` : ""} Make it modern, engaging, and fun — not boring or predictable. Think escape rooms, team challenges, scavenger hunts, minute-to-win-it, not just relay races.`
      );
      const parsed = parseAIJSON(raw);
      setGeneratedGame(parsed);
    } catch(e) { setError("Game generation failed: " + e.message); }
    finally { setLoading("gameGen", false); }
  };

  const postEvent = async () => {
    if (!eventForm.title || !eventForm.type || isLoading("postEvent")) return;
    setLoading("postEvent", true);
    try {
      const ev = { id: `ev_${Date.now()}`, title: sanitize(eventForm.title, 200), type: eventForm.type, date: eventForm.date || "TBD", desc: sanitize(eventForm.desc, 500), posted: new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}), reactions: { going: 0, interested: 0, praying: 0 } };
      await sharedAtomicUpdate("sf-events", prev => [ev, ...prev].slice(0, 50));
      setEvents(prev => [ev, ...prev]); setEventForm({ title: "", type: "", date: "", desc: "" }); setShowEventForm(false); showToast("📅 Event posted!");
    } catch(e) { setError(e.message); } finally { setLoading("postEvent", false); }
  };

  const reactEvent = async (eid, type) => {
    try {
      await sharedAtomicUpdate("sf-events", prev => prev.map(e => e.id === eid ? { ...e, reactions: { ...e.reactions, [type]: (e.reactions?.[type]||0)+1 } } : e));
      setEvents(prev => prev.map(e => e.id === eid ? { ...e, reactions: { ...e.reactions, [type]: (e.reactions?.[type]||0)+1 } } : e));
    } catch(e) { console.error("reactEvent:", e); }
  };

  const generateFamily = async () => {
    setLoading("family", true);
    try { const raw = await callClaude(P.family, "Generate family bonding activities. Mix fun and faith."); setFamilyActivities(parseAIJSON(raw)); }
    catch (e) { setError(e.message); } finally { setLoading("family", false); }
  };

  // ── AI Translation for sermon output ──
  const translateResult = async (targetLang) => {
    if (!result || targetLang === "en") return;
    const langName = LANGUAGES.find(l => l.code === targetLang)?.name || targetLang;
    if (!(await checkAndTrack("ai"))) return;
    setLoading("translate", true); setError(null);
    try {
      const raw = await callClaude(
        `You are a professional Bible translator. Translate the following sermon/study content into ${langName}. Keep the same JSON structure exactly. Return ONLY valid JSON with no markdown. Translate all text values but keep JSON keys in English.`,
        JSON.stringify(result)
      );
      const parsed = parseAIJSON(raw);
      setResult(parsed);
      showToast(`🌍 Translated to ${langName}`);
    } catch (e) { setError(e.message); } finally { setLoading("translate", false); }
  };

  // ── Session closing prayer ──
  const endSession = () => {
    setShowClosingPrayer(true);
  };

  // ── Viral Blessing Engine ──
  const BLESSING_MESSAGES = {
    giver: (name, count) => `✝ ${name} just blessed ${count === 1 ? "a pastor" : count + " pastors"} with free access to LordsGuide — AI-powered sermon prep & Bible study.\n\nEvery subscription gifts free accounts to pastors who can't afford study tools.\n\n"Freely ye have received, freely give." — Matthew 10:8\n\n🌍 lordsguide.com`,
    receiver: () => `✝ I just received a free gift — LordsGuide, an AI-powered sermon prep & Bible study tool, gifted by a brother or sister in Christ.\n\nSomeone I've never met prayed for me and gave so I could study God's Word.\n\n"Freely ye have received, freely give." — Matthew 10:8\n\nIf this blesses you, pass it on: lordsguide.com`,
  };

  const shareBlessing = async (type) => {
    const msg = type === "giver"
      ? BLESSING_MESSAGES.giver(blessingData.giverName, blessingData.receiverCount)
      : BLESSING_MESSAGES.receiver();
    
    if (navigator.share) {
      try {
        await navigator.share({ title: "LordsGuide — A Blessing Shared", text: msg, url: "https://lordsguide.com" });
        showToast("🕊️ Blessing shared!");
      } catch { /* user cancelled — that's okay */ }
    } else {
      // Fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(msg);
        showToast("📋 Copied! Share it with your friends");
      } catch {
        // Final fallback: show the text
        showToast("Share this: lordsguide.com");
      }
    }
    setShowBlessingModal(null);
  };

  // ── Daily Briefing / Faith News ──
  const NEWS_INTERESTS = [
    { id: "persecution", label: "⛓️ Persecuted Church", color: "#f87171" },
    { id: "missions", label: "✈️ Missions & Outreach", color: "#22c55e" },
    { id: "revival", label: "🔥 Revival & Awakening", color: "#f59e0b" },
    { id: "humanitarian", label: "🤝 Humanitarian Aid", color: "#5b8def" },
    { id: "youth", label: "🧑‍🤝‍🧑 Youth & Education", color: "#a78bfa" },
    { id: "science", label: "🔬 Faith & Science", color: C.blue },
    { id: "politics", label: "🏛️ Religious Freedom", color: "#c9a84c" },
    { id: "environment", label: "🌿 Creation Care", color: "#4ade80" },
  ];

  const generateBriefing = async () => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("briefing", true); setError(null);
    const prefs = briefingPrefs;
    const interestStr = prefs.interests.length > 0 ? prefs.interests.join(", ") : "general Christian news";
    const locationStr = prefs.local ? `Local area: ${prefs.local}. Region: ${prefs.region || "not specified"}.` : "No location specified — focus on global news.";
    try {
      const raw = await callClaude(
        `You are a Christian news curator and prayer guide. Generate a daily faith briefing. ALWAYS START with an inspiring/uplifting news story first. Then cover local, regional, and global news relevant to the Christian community. For each story, include a short prayer point. Return ONLY valid JSON:
{"date":"Today's date","inspiring":{"headline":"...","summary":"...","source":"...","prayer":"A short prayer inspired by this good news"},"local":[{"headline":"...","summary":"...","category":"...","prayer":"..."}],"regional":[{"headline":"...","summary":"...","category":"...","prayer":"..."}],"global":[{"headline":"...","summary":"...","category":"...","prayer":"..."}],"verse_of_encouragement":{"text":"...","ref":"..."},"closing_prayer":"A prayer covering all the needs mentioned above"}
Generate 2 local, 2 regional, and 3 global stories. Categories: persecution, missions, revival, humanitarian, youth, science, politics, environment.`,
        `User interests: ${interestStr}\n${locationStr}\nLanguage: ${LANGUAGES.find(l=>l.code===lang)?.name || "English"}\nGenerate a briefing with current-style news that reflects real-world issues Christians should pray about today.`
      );
      const parsed = parseAIJSON(raw);
      setBriefing(parsed);
      setShowBriefing(true);
      // Cache today's briefing
      store(`sf-briefing-${getTodayKey()}`, parsed);
    } catch (e) { setError(e.message); } finally { setLoading("briefing", false); }
  };

  const saveBriefingPrefs = (prefs) => {
    setBriefingPrefs(prefs);
    store("sf-briefing-prefs", prefs);
    setShowBriefingSetup(false);
    showToast("✅ Briefing preferences saved");
  };

  // Auto-load cached briefing
  useEffect(() => {
    (async () => {
      const cached = await load(`sf-briefing-${getTodayKey()}`, null);
      if (cached) setBriefing(cached);
    })();
  }, []);

  // ── Prayer Power Map functions ──
  const loadPrayers = async () => {
    try {
      const p = await sharedLoad("sf-prayers", []);
      setPrayers(p);
      const dayAgo = Date.now() - 86400000;
      setActivePrayerCount(p.filter(pr => new Date(pr.timestamp).getTime() > dayAgo).length);
    } catch(e) { console.error("loadPrayers:", e); }
  };

  const submitPrayer = async () => {
    const text = sanitize(prayerForm.text, INPUT_LIMITS.comment);
    if (!text || isLoading("submitPrayer")) return;
    setLoading("submitPrayer", true);
    try {
      const prayer = {
        id: `pr_${Date.now()}`, text,
        category: prayerForm.category,
        name: sanitize(prayerForm.name, 100) || user?.name || "Anonymous",
        urgent: prayerForm.urgent,
        timestamp: new Date().toISOString(),
        displayDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        displayTime: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        prayedBy: 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown",
        utcOffset: -(new Date().getTimezoneOffset() / 60),
      };
      await sharedAtomicUpdate("sf-prayers", prev => [prayer, ...prev].slice(0, 500));
      setPrayers(prev => [prayer, ...prev]);
      setPrayerForm({ text: "", category: "personal", name: "", urgent: false });
      setShowPrayerForm(false);
      showToast("🙏 Prayer submitted");
    } catch(e) { setError(e.message); } finally { setLoading("submitPrayer", false); }
  };

  const prayForRequest = async (prayerId) => {
    try {
      const key = `sf-prayed-${prayerId}`;
      const current = await sharedLoad(key, { count: 0 });
      current.count += 1;
      await sharedSave(key, current);
      setPrayers(prev => prev.map(p => p.id === prayerId ? { ...p, prayedBy: current.count } : p));
      showToast("🙏 Amen");
    } catch(e) { console.error("prayForRequest:", e); }
  };

  // ── Kids & Teens Corner AI ──
  const KIDS_MODES = [
    { id: "story", icon: "📖", title: "Bible Story", desc: "Animated retelling of a Bible story", color: "#f59e0b" },
    { id: "quiz", icon: "🎮", title: "Fun Quiz", desc: "Age-appropriate trivia with emojis", color: "#3d7a4f" },
    { id: "memory", icon: "🧠", title: "Memory Verse", desc: "Learn a verse with fill-in-the-blank", color: "#6b4c8a" },
    { id: "craft", icon: "✂️", title: "Craft & Activity", desc: "Make something that teaches a lesson", color: "#2c5f8a" },
    { id: "hero", icon: "⚔️", title: "Bible Hero", desc: "Meet a hero of faith", color: "#b94a48" },
    { id: "lesson", icon: "💡", title: "Life Lesson", desc: "What would Jesus do?", color: "#d4a84b" },
  ];

  const generateKidsContent = async (mode) => {
    if (!(await checkAndTrack("ai"))) return;
    setKidsMode(mode); setKidsResult(null); setLoading("kids", true); setError(null);
    const age = kidsAgeGroup;
    const prompts = {
      story: `You are a children's Bible storyteller. Tell an engaging Bible story for ages ${age}. Use simple language, vivid descriptions, and age-appropriate themes. Return ONLY JSON: {"title":"Story Title","bible_ref":"e.g. Genesis 6-9","characters":[{"name":"...","emoji":"...","role":"..."}],"story_parts":[{"heading":"Part title","text":"2-3 sentences","emoji":"Scene emoji"}],"moral":"The lesson we learn","prayer":"A simple prayer kids can say","discussion":["Question 1 for kids","Question 2"]}. Use 4-5 story parts.`,
      quiz: `You are a fun Bible quiz host for kids ages ${age}. Create an exciting quiz with emojis and encouraging feedback. Return ONLY JSON: {"title":"Quiz Title","emoji":"🎮","questions":[{"q":"Question with emoji","options":["A 🅰️","B 🅱️","C ©️","D 🇩"],"answer":0,"fun_fact":"Cool fact!","encouragement":"Great job! or Try again!"}]}. 6 questions, answer 0-indexed. Make it FUN.`,
      memory: `You are a children's Bible teacher helping kids ages ${age} memorize Scripture. Return ONLY JSON: {"verse_ref":"e.g. John 3:16","verse_text":"Full verse text","version":"KJV","fill_blanks":[{"display":"For God so loved the ___","answer":"world"},{"display":"that he gave his only begotten ___","answer":"Son"}],"hand_motions":"Describe simple hand motions for each phrase","song_idea":"A simple tune suggestion to sing the verse","activity":"A fun activity to reinforce the verse"}. Create 4-5 fill-in-the-blank exercises.`,
      craft: `You are a Sunday School craft instructor for ages ${age}. Design a Bible-themed craft activity. Return ONLY JSON: {"title":"Craft Name","bible_connection":"What Bible story/theme this teaches","materials":["item 1","item 2"],"steps":[{"step":1,"instruction":"What to do","tip":"Helpful hint"}],"bible_lesson":"What kids learn from making this","verse":"Related memory verse with reference"}. 5-6 steps. Use common household materials.`,
      hero: `You are a children's Bible teacher introducing a hero of faith to kids ages ${age}. Return ONLY JSON: {"name":"Hero name","emoji":"🦁","title":"e.g. The Brave Shepherd King","bible_ref":"e.g. 1 Samuel 16-17","era":"e.g. Old Testament, about 1000 BC","story":"3-4 paragraphs telling their story in kid-friendly language","superpowers":[{"power":"What made them special","emoji":"💪"}],"weakness":"Their human struggle","god_moment":"When God showed up in their life","what_we_learn":"The lesson for kids today","challenge":"A real-life challenge kids can try this week"}`,
      lesson: `You are a children's ministry leader helping kids ages ${age} apply faith to everyday life. Return ONLY JSON: {"title":"Lesson title","scenario":"A real-life situation kids face (2-3 sentences)","wrong_choice":{"action":"What most kids might do","result":"Why it doesn't work"},"wwjd":{"action":"What Jesus would do","verse":"Supporting Bible verse with reference","result":"The good outcome"},"role_play":"A fun role-play scenario for kids to practice","prayer":"A simple prayer about this situation","take_home":"One thing to remember all week"}`,
    };
    try {
      const raw = await callClaude(prompts[mode] || prompts.story, `Generate fresh content for children ages ${age}. Make it engaging, fun, and biblically accurate.`);
      setKidsResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("kids", false); }
  };

  // ── Teen Hub — The Mentorship Bridge ──
  const TEEN_MODES = [
    { id: "devotion", icon: "📖", title: "Daily Devo", desc: "Real talk, real Scripture, real life", color: "#2c5f8a" },
    { id: "challenge", icon: "🎯", title: "Faith Challenge", desc: "7-day challenges that build character", color: "#d4a84b" },
    { id: "discuss", icon: "💬", title: "Deep Questions", desc: "The hard questions faith demands", color: "#6b4c8a" },
    { id: "journal", icon: "✍️", title: "Faith Journal", desc: "Guided prompts for processing life", color: "#3d7a4f" },
    { id: "serve", icon: "🤝", title: "Serve Ideas", desc: "Ways to make a difference this week", color: "#b94a48" },
    { id: "identity", icon: "🪞", title: "Identity in Christ", desc: "Who God says you are", color: "#8b6914" },
  ];

  const MENTOR_TYPES = [
    { id: "teen-to-kid", icon: "🌟", label: "Teen → Kid", desc: "Share what you've learned with younger believers", color: "#d4a84b" },
    { id: "elder-to-teen", icon: "🕊️", label: "Elder → Teen", desc: "Wisdom from those who've walked the path", color: "#2c5f8a" },
    { id: "teen-to-teen", icon: "🤝", label: "Peer → Peer", desc: "Walk together, grow together", color: "#3d7a4f" },
  ];

  const generateTeenContent = async (mode) => {
    if (!(await checkAndTrack("ai"))) return;
    setTeenMode(mode); setTeenResult(null); setLoading("teen", true); setError(null);
    const prompts = {
      devotion: `You are a youth pastor writing for teens ages 13-18. Create a daily devotional that's authentic, not preachy. Use modern language teens actually speak. Address real struggles (anxiety, identity, social media, peer pressure, purpose). Return ONLY JSON: {"title":"Catchy title","hook":"Opening question or scenario teens relate to (2 sentences)","scripture":{"ref":"...","text":"Full verse text"},"real_talk":"3-4 paragraphs of honest, relatable teaching. No clichés. Speak TO them not AT them.","reflection":["3 personal reflection questions"],"prayer":"A prayer written in teen voice — honest, raw, real","action":"One specific thing to do today","playlist_vibe":"A worship song suggestion that fits the mood"}`,
      challenge: `You are a youth leader designing a 7-day faith challenge for teens 13-18. Make it practical, social-media-worthy, and genuinely transformative. Return ONLY JSON: {"title":"Challenge Name","theme":"Core theme","scripture":"Anchor verse with reference","days":[{"day":1,"title":"Day title","task":"Specific action to take","why":"Why this matters (1-2 sentences)","share":"How to share this on social media if they want"}],"reward":"The spiritual reward of completing all 7 days","mentor_note":"A note teens can share with their mentor about what they learned"}`,
      discuss: `You are a thoughtful youth mentor. Generate a deep discussion guide on a question teens actually wrestle with. Not surface-level. Return ONLY JSON: {"question":"The big question teens ask","why_it_matters":"Why this question is important (2 sentences)","what_world_says":"What culture/social media tells them","what_scripture_says":{"teaching":"What the Bible actually says (honest, not preachy)","verses":["Reference 1","Reference 2","Reference 3"]},"real_stories":"A brief real-world example or testimony","discussion_prompts":["5 follow-up questions for group discussion"],"for_mentors":"A note to adult mentors on how to navigate this topic with sensitivity"}`,
      journal: `You are a Christian counselor creating guided journal prompts for teens 13-18. Address real emotions and experiences. Return ONLY JSON: {"theme":"Journal Theme","opening":"A calming opening thought (2 sentences)","prompts":[{"prompt":"The journal question","guide":"A gentle nudge on how to start writing (1 sentence)","scripture":"A related verse for reflection"}],"closing":"An encouraging closing thought","prayer_prompt":"A sentence-starter prayer they can complete in their own words"}. Create 5 prompts.`,
      serve: `You are a youth service coordinator. Generate practical service project ideas for teens 13-18 that are doable this week, impactful, and teach Biblical principles. Return ONLY JSON: {"theme":"Service Theme","scripture":"Anchor verse","projects":[{"title":"Project name","description":"What to do (2-3 sentences)","impact":"Who it helps","time":"How long it takes","supplies":"What you need","faith_lesson":"The Biblical principle it teaches","mentor_role":"How an adult mentor can help"}],"reflection":"A reflection question after serving"}. Generate 5 projects.`,
      identity: `You are a youth pastor helping teens 13-18 understand their identity in Christ. Combat the lies of social media and comparison culture with Biblical truth. Return ONLY JSON: {"title":"Identity Truth","lie":"The lie the world tells teens (1 sentence)","truth":"What God says instead","scriptures":[{"ref":"...","text":"...","what_it_means":"In plain teen language"}],"story":"A brief relatable scenario where this truth matters","affirmation":"An 'I am' declaration based on Scripture","mirror_exercise":"A practical exercise: look in the mirror and say/do this","mentor_prompt":"A question to discuss with your mentor"}`,
    };
    try {
      const raw = await callClaude(prompts[mode] || prompts.devotion, `Generate fresh, authentic content for Christian teens. Be real. No church-speak.`);
      setTeenResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("teen", false); }
  };

  // ── Healthy Soul — Biblical Health & Nutrition ──
  const WELLNESS_MODES = [
    { id: "biblical-foods", icon: "🫒", title: "Biblical Foods", desc: "Explore foods from Scripture", color: "#3d7a4f" },
    { id: "daniel-fast", icon: "🍃", title: "Daniel Fast", desc: "Fasting guides with Scripture", color: "#2c5f8a" },
    { id: "healing-foods", icon: "🌿", title: "Healing Foods", desc: "Nutrition for body & spirit", color: "#8b6914" },
    { id: "biblical-recipe", icon: "🍞", title: "Biblical Recipe", desc: "Cook with Scripture ingredients", color: "#b94a48" },
    { id: "body-temple", icon: "🏛️", title: "Body Temple", desc: "Your body is a temple devotional", color: "#6b4c8a" },
    { id: "wellness-prayer", icon: "🙏", title: "Wellness Prayer", desc: "Healing, rest, and renewal", color: "#d4a84b" },
  ];

  const [wellnessMode, setWellnessMode] = useState(null);
  const [wellnessResult, setWellnessResult] = useState(null);
  const [wellnessQuery, setWellnessQuery] = useState("");
  // ── Gap closers: Discussion Qs, Reading Plans, Sermon Archive, Factbook ──
  const [discussionQs, setDiscussionQs] = useState(null);
  const [readingPlan, setReadingPlan] = useState(() => { try { const s = localStorage.getItem("lg-reading-plan"); return s ? JSON.parse(s) : null; } catch { return null; } });
  const [readingPlanDay, setReadingPlanDay] = useState(() => { try { return parseInt(localStorage.getItem("lg-reading-day") || "1"); } catch { return 1; } });
  const [sermonArchive, setSermonArchive] = useState(() => { try { const s = localStorage.getItem("lg-sermon-archive"); return s ? JSON.parse(s) : []; } catch { return []; } });
  const [showArchive, setShowArchive] = useState(false);
  const [factbookResult, setFactbookResult] = useState(null);
  const [showReadingPlans, setShowReadingPlans] = useState(false);

  const generateWellness = async (mode, query) => {
    if (!(await checkAndTrack("ai"))) return;
    setWellnessMode(mode); setWellnessResult(null); setLoading("wellness", true); setError(null);
    const prompts = {
      "biblical-foods": `You are a Biblical nutrition scholar. Given a food or ingredient, provide its complete Biblical and nutritional profile. Return ONLY JSON: {"food":"${query || 'olive oil'}","emoji":"🫒","hebrew_name":"Original Hebrew/Greek name","meaning":"What the name means","bible_references":[{"ref":"Scripture reference","context":"How this food appears in the passage","significance":"Why it matters"}],"nutritional_profile":{"calories":"per serving","key_nutrients":["nutrient 1","nutrient 2","nutrient 3"],"health_benefits":["benefit 1","benefit 2","benefit 3"]},"spiritual_symbolism":"What this food represents spiritually","how_to_use":"Modern ways to incorporate this into your diet","prayer":"A short prayer of gratitude for God's provision of this food","fun_fact":"An interesting historical or scientific fact"}`,

      "daniel-fast": `You are a Biblical fasting guide. Generate a personalized Daniel Fast plan. Return ONLY JSON: {"fast_name":"Daniel Fast","duration":"21 days","scripture_basis":"Daniel 1:12, Daniel 10:2-3","purpose":"${query || 'spiritual renewal and physical reset'}","what_to_eat":["Food category 1 with examples","Food category 2","Food category 3","Food category 4","Food category 5"],"what_to_avoid":["Category 1","Category 2","Category 3"],"daily_plan":[{"day":"Day 1-3","theme":"Breaking dependence","scripture":"Scripture for these days","meal_ideas":"Breakfast, lunch, dinner suggestions","prayer_focus":"What to pray about"},{"day":"Day 4-7","theme":"Deepening surrender","scripture":"...","meal_ideas":"...","prayer_focus":"..."},{"day":"Day 8-14","theme":"Seeking clarity","scripture":"...","meal_ideas":"...","prayer_focus":"..."},{"day":"Day 15-21","theme":"Breakthrough and renewal","scripture":"...","meal_ideas":"...","prayer_focus":"..."}],"breaking_the_fast":"How to safely end the fast","testimony":"An encouraging word about what God does through fasting"}`,

      "healing-foods": `You are a holistic health advisor grounded in Biblical wisdom. Given a health concern, suggest Biblical foods and spiritual practices. Return ONLY JSON: {"concern":"${query || 'stress and anxiety'}","scripture_comfort":"A comforting Scripture for this condition with reference","biblical_foods":[{"food":"Food name","emoji":"🍯","scripture":"Where this food appears in the Bible","how_it_helps":"Nutritional/medical benefit","preparation":"How to prepare/consume it"}],"spiritual_practices":[{"practice":"e.g. Prayer walking, Sabbath rest","scripture":"Supporting verse","benefit":"How this helps body and soul"}],"daily_routine":{"morning":"Morning wellness practice","afternoon":"Midday practice","evening":"Evening practice"},"prayer":"A healing prayer for this specific concern","disclaimer":"Reminder to consult healthcare professionals"}`,

      "biblical-recipe": `You are a creative chef who cooks with Biblical ingredients. Generate a delicious, healthy recipe using foods found in Scripture. Return ONLY JSON: {"recipe_name":"Creative name","emoji":"🍽️","description":"One sentence about this dish","servings":4,"prep_time":"15 min","cook_time":"30 min","biblical_ingredients":[{"ingredient":"e.g. 2 cups lentils","scripture":"Genesis 25:34 — Esau's stew","significance":"Brief note on this ingredient in the Bible"}],"modern_additions":["Any modern ingredients needed"],"instructions":["Step 1","Step 2","Step 3","Step 4","Step 5"],"nutritional_highlights":["High in protein","Rich in fiber"],"table_blessing":"A meal prayer connecting this food to Scripture","scripture_meditation":"A verse to meditate on while eating this meal"}`,

      "body-temple": `You are a devotional writer focused on the Biblical teaching that our bodies are temples of the Holy Spirit. Write a daily devotional on ${query || 'caring for your body as worship'}. Return ONLY JSON: {"title":"Devotional title","theme":"${query || 'body as temple'}","key_verse":{"text":"Full verse text","ref":"1 Corinthians 6:19-20 or similar"},"reflection":"3-4 paragraphs exploring how caring for our physical body is an act of worship. Include references to sleep, nutrition, exercise, rest, and mental health. Be warm, practical, not preachy.","body_check":{"physical":"One physical wellness action for today","mental":"One mental wellness practice","spiritual":"One spiritual practice"},"practical_challenge":"A specific, doable challenge for this week","prayer":"A prayer for strength, discipline, and gratitude for our bodies","quote":"An inspiring quote about health and faith"}`,

      "wellness-prayer": `You are a prayer guide specializing in physical, mental, and spiritual wellness. Write a guided wellness prayer for ${query || 'healing and renewal'}. Return ONLY JSON: {"title":"Prayer title","occasion":"${query || 'healing and renewal'}","opening":{"text":"Opening prayer (2-3 sentences)","posture":"Suggested physical posture (e.g. hands open, kneeling, walking)"},"body_scan":{"instruction":"Guide the person to notice their body — tension, pain, tiredness","prayer":"Prayer releasing physical burdens to God"},"mind_clearing":{"instruction":"Guide the person to notice anxious thoughts","prayer":"Prayer for mental peace, referencing Philippians 4:6-7"},"spirit_filling":{"instruction":"Guide the person to invite the Holy Spirit","prayer":"Prayer for spiritual renewal and strength"},"scripture_declarations":[{"verse":"Isaiah 53:5","declaration":"By His stripes I am healed"},{"verse":"Psalm 103:2-3","declaration":"He forgives all my sins and heals all my diseases"},{"verse":"3 John 1:2","declaration":"I prosper and am in health, even as my soul prospers"}],"closing":"Closing prayer with thanksgiving","wellness_action":"One physical wellness action to take after praying"}`,
    };
    try {
      const raw = await callClaude(prompts[mode] || prompts["body-temple"], `Generate fresh, practical, Biblically-grounded content about: ${query || "wellness and health"}. Be warm, encouraging, and specific.`);
      setWellnessResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("wellness", false); }
  };

  // ═══ GAP 1: Discussion Question Generator ═══
  const generateDiscussionQs = async (ref) => {
    const p = ref || passage;
    if (!p?.trim()) { showToast("Enter a passage first"); return; }
    if (!(await checkAndTrack("ai"))) return;
    setLoading("discussion", true); setDiscussionQs(null);
    try {
      const raw = await callClaude(
        `You are a Bible study leader with 20 years experience facilitating small groups. Generate discussion questions for a Bible study on a given passage. Return ONLY valid JSON:
{"passage":"${p}","title":"Discussion title","ice_breaker":"One fun opening question to get people talking","observation":[{"q":"Question about what the text says (3 questions)","hint":"Where to look in the passage"}],"interpretation":[{"q":"Question about what the text means (3 questions)","hint":"Key insight to guide discussion"}],"application":[{"q":"Question about how to apply this today (3 questions)","hint":"Practical connection to daily life"}],"going_deeper":"One challenging question for mature believers","prayer_prompt":"A suggested closing prayer focus","leader_tip":"One tip for the discussion leader"}`,
        `Generate discussion questions for: ${sanitize(p, 300)}${sermonContext ? `. Context: ${sanitize(sermonContext, 200)}` : ""}. Mix easy warm-up questions with deeper theological ones. Make application questions practical and personal.`
      );
      setDiscussionQs(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("discussion", false); }
  };

  // ═══ GAP 2: Reading Plans ═══
  const READING_PLANS = [
    { id: "bible-1yr", name: "Bible in 1 Year", days: 365, icon: "📖", desc: "Genesis to Revelation in 365 days" },
    { id: "psalms-31", name: "Psalms in 31 Days", days: 31, icon: "🎵", desc: "5 Psalms per day" },
    { id: "gospels-30", name: "Gospels in 30 Days", days: 30, icon: "✝", desc: "Walk with Jesus through all 4 Gospels" },
    { id: "proverbs-31", name: "Proverbs in 31 Days", days: 31, icon: "💡", desc: "One chapter of wisdom per day" },
    { id: "paul-21", name: "Paul's Letters in 21 Days", days: 21, icon: "✉️", desc: "Romans through Philemon" },
    { id: "genesis-30", name: "Genesis in 30 Days", days: 30, icon: "🌍", desc: "The beginning of everything" },
  ];

  const startReadingPlan = async (planId) => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("readingPlan", true);
    try {
      const plan = READING_PLANS.find(p => p.id === planId);
      const raw = await callClaude(
        `You are a Bible reading plan designer. Create a ${plan.days}-day reading plan for "${plan.name}". Return ONLY valid JSON:
{"plan_name":"${plan.name}","total_days":${plan.days},"days":[{"day":1,"reading":"Book Chapter:Verse-Verse","title":"Short title for today","key_verse":"One standout verse","thought":"1-2 sentence devotional thought","prayer":"Brief prayer for today"}]. Generate ALL ${plan.days} days. Keep readings balanced — roughly equal length each day.`,
        `Create the complete ${plan.days}-day plan. Be specific with every reading reference.`
      );
      const parsed = parseAIJSON(raw);
      setReadingPlan(parsed);
      setReadingPlanDay(1);
      localStorage.setItem("lg-reading-plan", JSON.stringify(parsed));
      localStorage.setItem("lg-reading-day", "1");
      showToast(`📖 Started: ${plan.name}`);
    } catch(e) { setError(e.message); } finally { setLoading("readingPlan", false); }
  };

  const advanceReadingDay = () => {
    const next = readingPlanDay + 1;
    if (next > (readingPlan?.total_days || 365)) { showToast("🎉 You completed the plan!"); return; }
    setReadingPlanDay(next);
    localStorage.setItem("lg-reading-day", String(next));
  };

  // ═══ GAP 3: Sermon Archive ═══
  const saveToArchive = (sermon) => {
    const entry = { id: Date.now(), title: sermon.title || docTitle || "Untitled Sermon", passage: passage, context: sermonContext, date: new Date().toISOString().split("T")[0], content: typeof sermon === "string" ? sermon : compiledSermon || docBlocks.map(b => `[${b.label}] ${b.content}`).join("\n\n"), occasion: "Sunday" };
    const updated = [entry, ...sermonArchive].slice(0, 100); // Keep last 100
    setSermonArchive(updated);
    localStorage.setItem("lg-sermon-archive", JSON.stringify(updated));
    showToast("📚 Saved to Sermon Archive");
  };

  // ═══ GAP 4: Factbook (People/Places/Things) ═══
  const lookupFactbook = async (term) => {
    if (!(await checkAndTrack("ai"))) return;
    setLoading("factbook", true); setFactbookResult(null);
    try {
      const raw = await callClaude(
        `You are a Biblical encyclopedia. Given a person, place, thing, or concept from the Bible, provide a comprehensive factbook entry. Return ONLY valid JSON:
{"term":"${term}","type":"person|place|thing|concept|event","emoji":"relevant emoji","summary":"2-3 sentence overview","details":{"also_known_as":"Other names or titles","era":"Time period","significance":"Why this matters in Biblical narrative"},"key_scriptures":[{"ref":"Reference","context":"How this term appears here"}],"timeline":[{"event":"What happened","when":"Approximate date or period"}],"connections":[{"related":"Related person/place/thing","relationship":"How they're connected"}],"did_you_know":"One surprising fact most people don't know","sermon_angle":"How a preacher might use this in a sermon","prayer":"A prayer inspired by this person/place/concept"}`,
        `Provide a factbook entry for: ${sanitize(term, 200)}. Be historically accurate and Biblically grounded.`
      );
      setFactbookResult(parseAIJSON(raw));
    } catch(e) { setError(e.message); } finally { setLoading("factbook", false); }
  };

  const submitMentorPost = async () => {
    const text = sanitize(mentorForm.text, INPUT_LIMITS.comment);
    if (!text || isLoading("mentorPost")) return;
    setLoading("mentorPost", true);
    try {
      const post = {
        id: `mp_${Date.now()}`, text, type: mentorForm.type,
        name: sanitize(mentorForm.name, 100) || user?.name || "Anonymous",
        timestamp: new Date().toISOString(),
        displayDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        hearts: 0,
      };
      await sharedAtomicUpdate("sf-mentor-posts", prev => [post, ...prev].slice(0, 200));
      setMentorPosts(prev => [post, ...prev]);
      setMentorForm({ text: "", type: "teen-to-kid", name: "" });
      setShowMentorForm(false);
      showToast("🌟 Mentor post shared!");
    } catch(e) { setError(e.message); } finally { setLoading("mentorPost", false); }
  };

  const heartMentorPost = async (postId) => {
    try {
      const key = `sf-mheart-${postId}`;
      const current = await sharedLoad(key, { count: 0 });
      current.count += 1;
      await sharedSave(key, current);
      setMentorPosts(prev => prev.map(p => p.id === postId ? { ...p, hearts: current.count } : p));
    } catch(e) { console.error("heartMentorPost:", e); }
  };

  // Load mentor posts
  useEffect(() => {
    (async () => { try { const mp = await sharedLoad("sf-mentor-posts", []); setMentorPosts(mp); } catch {} })();
  }, []);

  // Update prayer map clock every minute
  useEffect(() => {
    const interval = setInterval(() => setPrayerMapTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // Load prayers on init
  useEffect(() => { loadPrayers(); }, []);

  const filteredPrayers = useMemo(() => {
    const dayAgo = Date.now() - 86400000;
    return prayers
      .filter(p => new Date(p.timestamp).getTime() > dayAgo)
      .filter(p => prayerFilter === "all" || p.category === prayerFilter || (prayerFilter === "urgent" && p.urgent));
  }, [prayers, prayerFilter]);

  // Calculate which zones are currently "awake" (6am-10pm local)
  const getZoneStatus = (offset) => {
    const utcHour = prayerMapTime.getUTCHours() + prayerMapTime.getUTCMinutes() / 60;
    const localHour = (utcHour + offset + 24) % 24;
    if (localHour >= 5 && localHour < 7) return { status: "dawn", label: "Dawn Prayer", color: "#f59e0b", glow: true };
    if (localHour >= 7 && localHour < 12) return { status: "morning", label: "Morning", color: "#22c55e", glow: true };
    if (localHour >= 12 && localHour < 17) return { status: "day", label: "Midday", color: "#5b8def", glow: true };
    if (localHour >= 17 && localHour < 21) return { status: "evening", label: "Evening", color: "#a78bfa", glow: true };
    if (localHour >= 21 || localHour < 5) return { status: "night", label: "Night Watch", color: "#4b5563", glow: false };
    return { status: "day", label: "Active", color: "#22c55e", glow: true };
  };

  const shareCurrentSermon = () => {
    if (!result || resultType !== "sermon") return;
    const body = [
      result.introduction ? `INTRODUCTION\n🎣 ${result.introduction.hook}\n${result.introduction.context}\n→ ${result.introduction.thesis}` : "",
      ...(result.points||[]).map((p,i) => `\nPOINT ${i+1}: ${p.heading} (${p.verses})\n${p.explanation}\n💡 ${p.illustration}\n✋ ${p.application}`),
      result.conclusion ? `\nCONCLUSION\n${result.conclusion.summary}\n${result.conclusion.call}\n${result.conclusion.closing}` : "",
    ].filter(Boolean).join("\n");
    setShareForm({ author: user?.name || "", church: "", title: result.title || "", passage, body, tags: [] });
    setShareMode("compose"); setScreen("community");
  };

  // ── Export ──
  const exportDoc = () => {
    const t = docTitle || `Study: ${passage}`;
    let out = `${"═".repeat(50)}\n${t.toUpperCase()}\n${"═".repeat(50)}\n\n`;
    docBlocks.forEach(b => { out += `── ${b.label} ${"─".repeat(Math.max(0, 40 - b.label.length))}\n${b.content}\n\n`; });
    out += `${"─".repeat(50)}\nLordsGuide • The Miracle Edition\n⚠ AI-generated content — verify before citing\n`;
    navigator.clipboard?.writeText(out); showToast("📋 Document copied!");
  };

  // ── F10: Memoized podium sections ──
  const podiumSections = useMemo(() => {
    if (!result) return [];
    const s = [];
    if (result.introduction) s.push({ label: "Introduction", text: `🎣 ${result.introduction.hook}\n\n${result.introduction.context}\n\n→ ${result.introduction.thesis}` });
    result.points?.forEach((p, i) => s.push({ label: `Point ${i+1}`, text: `${i+1}. ${p.heading}\n\n${p.explanation}\n\n💡 ${p.illustration}\n\n✋ ${p.application}` }));
    if (result.conclusion) s.push({ label: "Conclusion", text: `${result.conclusion.summary}\n\n${result.conclusion.call}` });
    return s;
  }, [result]);

  const filteredIllustrations = useMemo(() => illustrations.filter(il => {
    const mt = illusCategory === "all" || il.type === illusCategory;
    const ms = !illusSearch || [il.title, il.content, il.query].some(f => f?.toLowerCase().includes(illusSearch.toLowerCase()));
    return mt && ms;
  }), [illustrations, illusCategory, illusSearch]);

  // ── Reusable components ──
  // ═══ DESIGN SYSTEM — Warm, Elegant, Light ═══
  const font = "'Libre Baskerville', 'Georgia', serif";
  const sans = "'DM Sans', 'Segoe UI', sans-serif";
  const mono = "'DM Mono', 'Menlo', monospace";
  const cardS = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" };
  const inputS = { width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", color: C.text, fontSize: 15, fontFamily: sans, boxSizing: "border-box", outline: "none", transition: "border-color 0.2s" };
  const tagS = (color) => ({ display: "inline-block", background: `${color}10`, border: `1px solid ${color}25`, color, padding: "4px 12px", borderRadius: 20, fontSize: 11, fontFamily: sans, fontWeight: 500, marginRight: 5, marginBottom: 4 });
  const secH = { fontSize: 11, color: C.dim, fontFamily: sans, textTransform: "uppercase", letterSpacing: 1.5, margin: "18px 0 8px", fontWeight: 600 };

  const AddBtn = ({ label, content, small }) => (
    <button onClick={e => { e.stopPropagation(); addToDoc("snippet", label, content); }}
      aria-label={`Add ${label} to document`}
      style={{ background: `${C.green}15`, border: `1px solid ${C.green}40`, color: C.green, borderRadius: 6, padding: small ? "2px 7px" : "4px 10px", fontSize: small ? 9 : 10, fontFamily: mono, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
      + Doc
    </button>
  );

  // F11: Error banner with retry
  const ErrorBanner = () => error ? (
    <div role="alert" style={{ ...cardS, borderColor: `${C.red}35`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <p style={{ fontSize: 12, color: C.red, margin: 0, flex: 1 }}>⚠ {error}</p>
      <div style={{ display: "flex", gap: 4 }}>
        {lastFailedOp && <button onClick={() => { setError(null); typeof lastFailedOp === "function" && lastFailedOp(); }} style={{ background: `${C.red}15`, border: `1px solid ${C.red}30`, color: C.red, padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 10, fontFamily: mono }}>Retry</button>}
        <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 14 }}>✕</button>
      </div>
    </div>
  ) : null;

  // ═══ RENDER ═══
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: sans, paddingBottom: screen === "podium" ? 0 : 68 }}>
      <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(61,122,79,0.08)}50%{box-shadow:0 0 36px rgba(61,122,79,0.15)}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        button{transition:all 0.15s ease}button:active{transform:scale(0.97)}
        input::placeholder,textarea::placeholder{color:#b5a99a}
        input:focus,textarea:focus{border-color:#8b6914!important;box-shadow:0 0 0 3px rgba(139,105,20,0.1)}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#e8e0d4;border-radius:4px}
      `}</style>

      {/* Toast with optional undo action (F12) */}
      {toast && (
        <div role="status" aria-live="polite" style={{ position: "fixed", bottom: 76, left: "50%", transform: "translateX(-50%)", background: toast.action ? C.gold : C.green, color: "#fff", padding: "8px 20px", borderRadius: 24, fontSize: 13, fontWeight: 600, fontFamily: sans, zIndex: 999, display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}>
          {toast.msg || toast}
          {toast.action && <button onClick={() => { toast.onAction?.(); setToast(null); }} style={{ background: "rgba(255,255,255,0.25)", border: "none", color: "#fff", padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{toast.action}</button>}
        </div>
      )}

      {/* ═══ AUTH MODAL ═══ (F1) */}
      {authScreen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(45,36,22,0.5)", backdropFilter: "blur(8px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: 28, width: "100%", maxWidth: 380, boxShadow: "0 20px 60px rgba(0,0,0,0.12)" }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: "0 0 4px", textAlign: "center", fontFamily: font }}>
              {authScreen === "miracle-request" ? "🕊️ Request a Miracle" : authScreen === "signup" ? "Welcome to LordsGuide" : "Welcome Back"}
            </h2>
            <p style={{ fontSize: 13, color: C.dim, textAlign: "center", margin: "0 0 20px" }}>
              {authScreen === "miracle-request" ? "A brother or sister in Christ will gift you access" : "Enter your details to continue"}
            </p>
            <input value={authForm.name} onChange={e => setAuthForm(f=>({...f,name:e.target.value}))} placeholder="Your name" aria-label="Name" style={{ ...inputS, marginBottom: 10 }} />
            <input value={authForm.email} onChange={e => setAuthForm(f=>({...f,email:e.target.value}))} placeholder="Email" type="email" aria-label="Email" style={{ ...inputS, marginBottom: 14 }} />
            {authScreen === "signup" && (
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {TIERS.map(t => (
                  <button key={t.id} onClick={() => setAuthForm(f=>({...f,tier:t.id}))} style={{
                    flex: 1, padding: "8px 4px", background: authForm.tier === t.id ? `${t.color}15` : C.surface,
                    border: `1px solid ${authForm.tier === t.id ? `${t.color}40` : C.border}`,
                    borderRadius: 8, cursor: "pointer", textAlign: "center",
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: authForm.tier === t.id ? t.color : C.dim }}>{t.name}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{t.price}</div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={login} disabled={!authForm.email} style={{
              width: "100%", padding: 12, background: authForm.email ? `linear-gradient(135deg, ${C.gold}, #a0832e)` : C.surface,
              border: "none", borderRadius: 8, color: authForm.email ? "#fff" : C.dim,
              fontSize: 14, fontWeight: 700, cursor: authForm.email ? "pointer" : "default", fontFamily: font, marginBottom: 8,
            }}>{authScreen === "miracle-request" ? "🙏 Submit Miracle Request" : "Continue"}</button>
            <button onClick={() => setAuthScreen(null)} style={{ width: "100%", padding: 8, background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ═══ LANDING ═══ */}
      {screen === "landing" && (
        <div style={{ animation: "fadeUp 0.6s ease", padding: "0 24px", maxWidth: 440, margin: "0 auto" }}>
          {/* Daily Inspirational Greeting — soft warm card */}
          <div style={{ background: C.warm, borderRadius: 16, padding: "20px 22px", margin: "24px 0 0", textAlign: "center", boxShadow: "0 2px 12px rgba(139,105,20,0.06)" }}>
            <div style={{ fontSize: 10, fontFamily: sans, color: C.gold, textTransform: "uppercase", letterSpacing: 2, marginBottom: 8, fontWeight: 600 }}>Today's Word for You</div>
            <p style={{ fontSize: 16, color: C.text, margin: "0 0 8px", fontStyle: "italic", lineHeight: 1.7, fontFamily: font }}>"{dailyQuote.text}"</p>
            <span style={{ fontSize: 11, color: C.gold, fontFamily: sans, fontWeight: 500 }}>— {dailyQuote.ref}</span>
          </div>

          {/* Daily Briefing — gentle blue card */}
          <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            <button onClick={briefing ? () => setShowBriefing(true) : generateBriefing} disabled={isLoading("briefing")} style={{ flex: 1, padding: 14, background: isLoading("briefing") ? C.surface : C.card, border: `1px solid ${C.blue}20`, borderRadius: 12, color: isLoading("briefing") ? C.dim : C.blue, fontSize: 14, fontWeight: 600, cursor: isLoading("briefing") ? "default" : "pointer", fontFamily: sans, boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>{isLoading("briefing") ? "Preparing..." : briefing ? "📰 Daily Briefing" : "📰 Get Today's Briefing"}</button>
            <button onClick={() => setShowBriefingSetup(true)} style={{ padding: "0 14px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, color: C.dim, fontSize: 14, cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }} aria-label="Briefing preferences">⚙</button>
          </div>

          {/* Briefing Setup */}
          {showBriefingSetup && (
            <div style={{ ...cardS, padding: 18, marginBottom: 12, animation: "fadeUp 0.3s ease" }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 12px", fontFamily: font }}>Briefing Preferences</h3>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: C.dim, fontFamily: sans, fontWeight: 500 }}>Your city or town</label>
                <input value={briefingPrefs.local} onChange={e => setBriefingPrefs(p=>({...p,local:e.target.value}))} placeholder="e.g. Puerto Princesa, Manila, Lagos" maxLength={100} style={{ ...inputS, fontSize: 13, marginTop: 4 }} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: C.dim, fontFamily: sans, fontWeight: 500 }}>Region or country</label>
                <input value={briefingPrefs.region} onChange={e => setBriefingPrefs(p=>({...p,region:e.target.value}))} placeholder="e.g. Palawan, Philippines" maxLength={100} style={{ ...inputS, fontSize: 13, marginTop: 4 }} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: C.dim, fontFamily: sans, fontWeight: 500, marginBottom: 6, display: "block" }}>Topics you care about</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {NEWS_INTERESTS.map(ni => {
                    const active = briefingPrefs.interests.includes(ni.id);
                    return <button key={ni.id} onClick={() => setBriefingPrefs(p => ({...p, interests: active ? p.interests.filter(i=>i!==ni.id) : [...p.interests, ni.id]}))} style={{ background: active?`${ni.color}10`:C.surface, border: `1px solid ${active?`${ni.color}30`:C.border}`, color: active?ni.color:C.dim, borderRadius: 20, padding: "5px 10px", fontSize: 11, cursor: "pointer", fontFamily: sans, fontWeight: 500 }}>{ni.label}</button>;
                  })}
                </div>
              </div>
              <button onClick={() => saveBriefingPrefs(briefingPrefs)} style={{ width: "100%", padding: 12, background: C.gold, border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>Save Preferences</button>
            </div>
          )}

          {/* Hero — clean, warm, centered */}
          <div style={{ textAlign: "center", paddingTop: 28, paddingBottom: 32 }}>
            <div style={{ fontSize: 44, marginBottom: 10, animation: "float 3s ease infinite", color: C.gold }} role="img" aria-label="Cross">✝</div>
            <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 6px", color: C.text, lineHeight: 1.1, fontFamily: font }}>LordsGuide</h1>
            <p style={{ fontSize: 14, color: C.dim, margin: "0 0 4px", fontStyle: "italic", fontFamily: font }}>The Miracle Edition</p>
            <p style={{ fontSize: 14, color: C.dim, margin: "0 0 20px", lineHeight: 1.6 }}>AI-powered sermon prep & Bible study.<br/>Every purchase gives the gift of Scripture to someone in need.</p>

            {/* Language Selector */}
            <div style={{ marginBottom: 20 }}>
              <button onClick={() => setShowLangPicker(!showLangPicker)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 16px", color: C.dim, fontSize: 12, cursor: "pointer", fontFamily: sans, fontWeight: 500, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>🌍 {LANGUAGES.find(l=>l.code===lang)?.native || "English"} ▾</button>
              {showLangPicker && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, justifyContent: "center", marginTop: 8 }}>
                  {LANGUAGES.map(l => (
                    <button key={l.code} onClick={() => { setLang(l.code); setShowLangPicker(false); store("sf-lang", l.code); }} style={{ background: lang===l.code?`${C.gold}12`:C.card, border: `1px solid ${lang===l.code?`${C.gold}30`:C.border}`, color: lang===l.code?C.gold:C.dim, borderRadius: 8, padding: "5px 10px", fontSize: 11, cursor: "pointer", fontFamily: sans }}>{l.native}</button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: `${C.miracle}08`, border: `1px solid ${C.miracle}25`, borderRadius: 16, padding: "16px 20px", marginBottom: 24, animation: "glow 4s ease infinite" }} aria-label={`${miracleCount} miracles given`}>
              <div style={{ fontSize: 11, color: C.miracle, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Miracles Given</div>
              <div style={{ fontSize: 36, fontWeight: 700, color: C.miracle, fontFamily: mono }}>{miracleCount.toLocaleString()}</div>
              <p style={{ fontSize: 12, color: "#6ee7a0", margin: "6px 0 0" }}>Free accounts gifted to those who asked in faith</p>
            </div>

            {user ? (
              <button onClick={() => setScreen("home")} style={{ width: "100%", padding: 16, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 12, color: "#fff", fontSize: 17, fontWeight: 700, cursor: "pointer", fontFamily: font, marginBottom: 10 }}>⚡ Continue as {user.name}</button>
            ) : (
              <>
                <button onClick={() => setAuthScreen("signup")} style={{ width: "100%", padding: 16, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 12, color: "#fff", fontSize: 17, fontWeight: 700, cursor: "pointer", fontFamily: font, marginBottom: 10 }}>⚡ Get Started</button>
                <button onClick={() => { setAuthForm(f=>({...f,tier:"miracle"})); setAuthScreen("miracle-request"); }} style={{ width: "100%", padding: 14, background: `${C.miracle}12`, border: `1px solid ${C.miracle}30`, borderRadius: 12, color: C.miracle, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: font, marginBottom: 10 }}>🕊️ Request a Miracle (Free)</button>
                <button onClick={() => setAuthScreen("login")} style={{ width: "100%", padding: 10, background: "none", border: `1px solid ${C.border}`, borderRadius: 10, color: C.dim, fontSize: 13, cursor: "pointer", fontFamily: font }}>Already have an account? Sign in</button>
              </>
            )}
          </div>

          <div style={{ marginBottom: 30 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: C.goldL, textAlign: "center", margin: "0 0 16px" }}>How The Miracle Works</h2>
            {[
              { icon: "🙏", title: "Someone Asks", desc: "A pastor who can't afford tools submits a Miracle request." },
              { icon: "💛", title: "You Give", desc: "Every subscription funds a free Miracle account." },
              { icon: "✝", title: "They Receive", desc: "Full AI Bible study — completely free." },
              { icon: "🌊", title: "The Ripple", desc: "Better sermons, deeper studies, the Word spreads." },
            ].map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, animation: `fadeUp ${0.3+i*0.15}s ease` }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: `${C.miracle}10`, border: `1px solid ${C.miracle}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }} role="img" aria-label={step.title}>{step.icon}</div>
                <div><div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{step.title}</div><div style={{ fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{step.desc}</div></div>
              </div>
            ))}
          </div>

          <div style={{ textAlign: "center", padding: "20px 0 40px", borderTop: `1px solid ${C.border}` }}>
            <p style={{ fontSize: 14, color: "#6b7280", fontStyle: "italic", margin: 0 }}>"Freely ye have received, freely give."</p>
            <p style={{ fontSize: 11, color: "#4b5563", fontFamily: mono, margin: "4px 0 0" }}>— Matthew 10:8 KJV</p>
          </div>
        </div>
      )}

      {/* ═══ HEADER ═══ */}
      {!["landing", "pricing", "podium"].includes(screen) && (
        <header style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 18px", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 1px 6px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: C.text, fontFamily: font }}>LordsGuide</h1>
              <p style={{ fontSize: 10, color: C.dim, margin: "2px 0 0", fontFamily: sans }}>
                {passage && `📖 ${passage}`}{!isOnline && " · Offline"}{user && ` · ${user.name}`}
              </p>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {docBlocks.length > 0 && screen !== "document" && <button onClick={() => setScreen("document")} aria-label={`Document with ${docBlocks.length} blocks`} style={{ background: `${C.green}10`, border: `1px solid ${C.green}25`, color: C.green, padding: "5px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: sans, fontWeight: 600 }}>📄 {docBlocks.length}</button>}
              {user && <button onClick={logout} aria-label="Sign out" style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.dim, padding: "5px 10px", borderRadius: 8, fontSize: 10, cursor: "pointer", fontFamily: sans }}>Sign out</button>}
              <button onClick={endSession} aria-label="End session with prayer" style={{ background: `${C.purple}08`, border: `1px solid ${C.purple}20`, color: C.purple, padding: "5px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: sans }}>🙏</button>
              <button onClick={() => setScreen("landing")} aria-label="Home" style={{ background: `${C.gold}08`, border: `1px solid ${C.gold}20`, color: C.gold, padding: "5px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>✝</button>
            </div>
          </div>
        </header>
      )}

      {/* ═══ MAIN ═══ */}
      {!["landing", "pricing", "podium"].includes(screen) && (
        <main style={{ padding: "12px 16px", maxWidth: 600, margin: "0 auto" }} role="main">
          {!isOnline && <div role="alert" style={{ background: `${C.gold}12`, border: `1px solid ${C.gold}30`, borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}><span>📴</span><div><div style={{ fontSize: 12, fontWeight: 700, color: C.goldL }}>Offline</div><div style={{ fontSize: 10, color: C.dim }}>Cached content available • Doc editing works</div></div></div>}
          <ErrorBanner />

          {/* HOME */}
          {screen === "home" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {/* Tier usage indicator */}
              {user && user.tier === "miracle" && (
                <div style={{ background: `${C.miracle}08`, border: `1px solid ${C.miracle}20`, borderRadius: 8, padding: "6px 10px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: C.miracle }}>🕊️ Miracle Tier</span>
                  <span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{usage.aiCalls}/{TIER_LIMITS[user.tier]?.aiCallsPerDay || 10} AI calls today</span>
                </div>
              )}
              {!user && (
                <button onClick={() => setAuthScreen("signup")} style={{ width: "100%", padding: 10, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 8, color: C.goldL, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, marginBottom: 10 }}>✝ Sign in to start studying</button>
              )}
              <div style={secH}>What are you studying?</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                <input value={passage} onChange={e => { setPassage(e.target.value); setPassageError(null); }} placeholder="e.g. Romans 8:28 or Psalm 23, John 3:16" aria-label="Bible passages — separate multiple with commas" maxLength={300} style={{ ...inputS, flex: 1, borderColor: passageError ? C.red : C.border }} />
                <button onClick={() => { if(validatePassage(passage)) { loadBible(); setScreen("bible"); }}} style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}35`, color: C.blue, borderRadius: 8, padding: "0 14px", fontSize: 12, fontFamily: mono, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>📖 Read</button>
              </div>
              {/* Popular passages — tap to fill */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                {["John 3:16","Romans 8:28","Psalm 23","Phil 4:13","Jer 29:11","Matt 28:19","Isaiah 40:31","Prov 3:5-6","Gen 1:1","Rev 21:4"].map(p => (
                  <button key={p} onClick={() => { setPassage(p); setPassageError(null); }} style={{ padding: "3px 8px", background: passage===p?`${C.gold}15`:C.surface, border: `1px solid ${passage===p?C.gold:C.border}`, borderRadius: 12, fontSize: 9, color: passage===p?C.gold:C.dim, cursor: "pointer" }}>{p}</button>
                ))}
              </div>
              {passageError && <p role="alert" style={{ fontSize: 11, color: C.red, margin: "0 0 6px" }}>⚠ {passageError}</p>}

              {/* Sermon context / direction */}
              <div style={secH}>Context / Direction <span style={{ fontWeight: 400, color: C.dim }}>(optional)</span></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                {["Sunday Sermon","Youth Group","Bible Study","Funeral","Wedding","Evangelism","Easter","Christmas","Baptism","Grief & Loss","Men's Group","Women's Group"].map(c => (
                  <button key={c} onClick={() => setSermonContext(c)} style={{ padding: "3px 8px", background: sermonContext===c?`${C.blue}15`:C.surface, border: `1px solid ${sermonContext===c?C.blue:C.border}`, borderRadius: 12, fontSize: 9, color: sermonContext===c?C.blue:C.dim, cursor: "pointer" }}>{c}</button>
                ))}
              </div>
              <input value={sermonContext} onChange={e => setSermonContext(e.target.value)} placeholder="Or type your own context..." maxLength={300} style={{ ...inputS, marginBottom: 6, fontSize: 11 }} />

              {/* Scripture Finder — don't know the passage? describe what you mean */}
              {!showScriptureFinder ? (
                <button onClick={() => setShowScriptureFinder(true)} style={{ background: "none", border: "none", color: C.gold, fontSize: 11, cursor: "pointer", padding: "2px 0 10px", fontFamily: font, textDecoration: "underline" }}>🔍 Don't know the passage? Describe what you're looking for</button>
              ) : (
                <div style={{ ...cardS, padding: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.gold, fontWeight: 600, marginBottom: 6 }}>🔍 Scripture Finder</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
                    {["God's plan","Comfort in grief","Forgiveness","Anxiety & peace","Healing","Strength","Marriage","Purpose","Faith & doubt","Provision"].map(s => (
                      <button key={s} onClick={() => setScriptureFindQuery(s)} style={{ padding: "3px 8px", background: scriptureFindQuery===s?`${C.gold}15`:C.surface, border: `1px solid ${scriptureFindQuery===s?C.gold:C.border}`, borderRadius: 12, fontSize: 9, color: scriptureFindQuery===s?C.gold:C.dim, cursor: "pointer" }}>{s}</button>
                    ))}
                  </div>
                  <input value={scriptureFindQuery} onChange={e => setScriptureFindQuery(e.target.value)} placeholder="Or describe what you're looking for..." maxLength={200} style={{ ...inputS, marginBottom: 6, fontSize: 12 }} />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={findScripture} disabled={!scriptureFindQuery.trim() || isLoading("findScripture")} style={{ flex: 1, padding: 8, background: scriptureFindQuery.trim() ? C.gold : C.surface, border: "none", borderRadius: 6, color: scriptureFindQuery.trim() ? "#fff" : C.dim, fontSize: 12, fontWeight: 600, cursor: scriptureFindQuery.trim() ? "pointer" : "default" }}>{isLoading("findScripture") ? "⏳ Finding..." : "Find Passages"}</button>
                    <button onClick={() => { setShowScriptureFinder(false); setScriptureFindResults([]); }} style={{ padding: "8px 12px", background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.dim, fontSize: 11, cursor: "pointer" }}>✕</button>
                  </div>
                  {scriptureFindResults.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Tap a passage to use it:</div>
                      {scriptureFindResults.map((r, i) => (
                        <button key={i} onClick={() => { setPassage(r.ref); setShowScriptureFinder(false); setScriptureFindResults([]); showToast(`📖 Set to ${r.ref}`); }} style={{ display: "block", width: "100%", textAlign: "left", padding: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.gold }}>{r.ref}</span>
                          <span style={{ fontSize: 11, color: C.text, display: "block", marginTop: 2 }}>{r.summary}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Quick access: Prayer Wall */}
              <button onClick={() => { setScreen("community"); setHubTab("prayer"); }} style={{ width: "100%", padding: 8, background: `${C.miracle}08`, border: `1px solid ${C.miracle}20`, borderRadius: 8, color: C.miracle, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: font, marginBottom: 14 }}>🙏 Open Prayer Wall</button>

              {/* Reading Plan widget — shows if active */}
              {readingPlan && readingPlan.days?.[readingPlanDay - 1] && (() => {
                const today = readingPlan.days[readingPlanDay - 1];
                return (
                  <div style={{ ...cardS, padding: 12, marginBottom: 10, borderLeft: `3px solid ${C.green}`, background: `${C.green}04` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>📖 {readingPlan.plan_name}</span>
                      <span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>Day {readingPlanDay}/{readingPlan.total_days}</span>
                    </div>
                    <div style={{ width: "100%", height: 3, background: C.border, borderRadius: 2, marginBottom: 6 }}><div style={{ width: `${(readingPlanDay/readingPlan.total_days)*100}%`, height: "100%", background: C.green, borderRadius: 2 }}/></div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>{today.title}</div>
                    <button onClick={() => { setPassage(today.reading); loadBible(today.reading); setScreen("bible"); }} style={{ background: "none", border: "none", color: C.gold, fontSize: 12, cursor: "pointer", padding: 0, fontFamily: font, textDecoration: "underline" }}>📖 {today.reading}</button>
                    {today.key_verse && <p style={{ fontSize: 11, color: C.gold, margin: "4px 0", fontStyle: "italic" }}>✦ {today.key_verse}</p>}
                    <p style={{ fontSize: 11, color: C.dim, margin: "2px 0 6px", lineHeight: 1.4 }}>{today.thought}</p>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={advanceReadingDay} style={{ flex: 1, padding: 8, background: C.green, border: "none", borderRadius: 6, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✅ Mark Complete</button>
                      <button onClick={() => { setReadingPlan(null); localStorage.removeItem("lg-reading-plan"); localStorage.removeItem("lg-reading-day"); showToast("Plan cleared"); }} style={{ padding: "8px 12px", background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.dim, fontSize: 10, cursor: "pointer" }}>✕</button>
                    </div>
                  </div>
                );
              })()}

              {/* Start a Reading Plan — only show if no active plan */}
              {!readingPlan && (
                <div style={{ marginBottom: 10 }}>
                  <button onClick={() => setShowReadingPlans(!showReadingPlans)} style={{ width: "100%", padding: 8, background: `${C.green}06`, border: `1px solid ${C.green}18`, borderRadius: 8, color: C.green, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{showReadingPlans ? "✕ Close" : "📖 Start a Reading Plan"}</button>
                  {showReadingPlans && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                    {READING_PLANS.map(p => (
                      <button key={p.id} onClick={() => startReadingPlan(p.id)} disabled={isLoading("readingPlan")} style={{ ...cardS, cursor: "pointer", textAlign: "center", padding: 10 }}>
                        <div style={{ fontSize: 20, marginBottom: 2 }}>{p.icon}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{p.name}</div>
                        <div style={{ fontSize: 9, color: C.dim }}>{p.days} days</div>
                      </button>
                    ))}
                  </div>}
                  {isLoading("readingPlan") && <p style={{ textAlign: "center", color: C.dim, fontSize: 11, marginTop: 4 }}>⏳ Building your plan...</p>}
                </div>
              )}

              <div style={secH}>What do you need?</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {[
                  { id: "sermon", icon: "🎤", label: "Generate Sermon", desc: "AI builds a 3-point outline", color: C.gold },
                  { id: "topical", icon: "🔗", label: "Topical Study", desc: "Explore a theme across Scripture", color: C.blue },
                ].map(m => (
                  <button key={m.id} onClick={() => { setStudyMode(m.id); if (m.id === "sermon" && passage) generate(); }} aria-pressed={studyMode===m.id} style={{ flex: 1, padding: "14px 8px", background: C.card, border: `1px solid ${m.color}30`, borderRadius: 12, cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 24, marginBottom: 4 }}>{m.icon}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: m.color }}>{m.label}</div>
                    <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{m.desc}</div>
                  </button>
                ))}
              </div>

              {/* Open Bible button — always visible */}
              <button onClick={() => { if(passage) { loadBible(); setScreen("bible"); } else { setScreen("bible"); } }} style={{ width: "100%", padding: 12, background: `${C.blue}08`, border: `1px solid ${C.blue}20`, borderRadius: 10, color: C.blue, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: font, marginBottom: 6 }}>📖 Open Bible {passage ? `(${passage})` : ""}</button>

              {/* Discussion Questions button */}
              <button onClick={() => generateDiscussionQs()} disabled={isLoading("discussion") || !passage?.trim()} style={{ width: "100%", padding: 10, background: passage?.trim() ? `${C.purple}08` : C.surface, border: `1px solid ${passage?.trim() ? C.purple : C.border}20`, borderRadius: 10, color: passage?.trim() ? C.purple : C.dim, fontSize: 12, fontWeight: 600, cursor: passage?.trim() ? "pointer" : "default", fontFamily: font, marginBottom: 10 }}>{isLoading("discussion") ? "⏳ Generating questions..." : "💬 Generate Discussion Questions"}</button>

              {/* Discussion Questions results */}
              {discussionQs && (
                <div style={{ ...cardS, borderLeft: `3px solid ${C.purple}`, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.purple }}>💬 {discussionQs.title}</span>
                    <button onClick={() => setDiscussionQs(null)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer" }}>✕</button>
                  </div>
                  {discussionQs.ice_breaker && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginBottom: 6 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>ICE BREAKER</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>🎯 {discussionQs.ice_breaker}</p></div>}
                  {[{k:"observation",title:"📖 Observation",color:C.blue,sub:"What does the text say?"},{k:"interpretation",title:"🔍 Interpretation",color:C.purple,sub:"What does it mean?"},{k:"application",title:"✅ Application",color:C.green,sub:"How do I live it?"}].map(sec => (
                    <div key={sec.k} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: sec.color, marginBottom: 3 }}>{sec.title} <span style={{ fontSize: 9, color: C.dim, fontWeight: 400 }}>— {sec.sub}</span></div>
                      {discussionQs[sec.k]?.map((q, i) => (
                        <div key={i} style={{ background: C.surface, borderRadius: 6, padding: 6, marginBottom: 3 }}>
                          <p style={{ fontSize: 12, color: C.text, margin: 0 }}>{q.q}</p>
                          {q.hint && <p style={{ fontSize: 9, color: C.dim, margin: "2px 0 0", fontStyle: "italic" }}>💡 {q.hint}</p>}
                        </div>
                      ))}
                    </div>
                  ))}
                  {discussionQs.going_deeper && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 6, marginBottom: 6 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>GOING DEEPER</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>{discussionQs.going_deeper}</p></div>}
                  {discussionQs.leader_tip && <p style={{ fontSize: 10, color: C.green, margin: "4px 0" }}>💡 Leader tip: {discussionQs.leader_tip}</p>}
                  <AddBtn label="Discussion Questions" content={`${discussionQs.title}\n\nIce Breaker: ${discussionQs.ice_breaker}\n\nObservation:\n${discussionQs.observation?.map(q=>q.q).join('\n')}\n\nInterpretation:\n${discussionQs.interpretation?.map(q=>q.q).join('\n')}\n\nApplication:\n${discussionQs.application?.map(q=>q.q).join('\n')}`} />
                  <AIDisclaimer type="discussion" />
                </div>
              )}

              {/* Topical topic selector — only shows when topical selected */}
              {studyMode === "topical" && (
                <>
                  <div style={secH}>Topic</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                    {TOPICS.map(t => <button key={t} onClick={() => setTopic(t)} aria-pressed={topic===t} style={{ ...tagS(topic===t?C.blue:C.dim), cursor: "pointer", background: topic===t?`${C.blue}18`:C.card }}>{t}</button>)}
                  </div>
                  {topic === "Custom..." && <input value={customTopic} onChange={e => setCustomTopic(e.target.value)} placeholder="Your topic..." maxLength={INPUT_LIMITS.topic} style={{ ...inputS, marginBottom: 10 }} />}
                  <button onClick={generate} disabled={isLoading("generate")} style={{ width: "100%", padding: 14, background: isLoading("generate") ? C.card : `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 10, color: isLoading("generate") ? C.dim : "#fff", fontSize: 15, fontWeight: 700, cursor: isLoading("generate") ? "default" : "pointer", fontFamily: font, marginBottom: 8 }}>{isLoading("generate") ? "⏳ Building Study..." : "⚡ Build Study"}</button>
                </>
              )}

              {/* Quick access row — Prayer, Briefing, End Session */}
              <div style={{ display: "flex", gap: 6, marginTop: 6, marginBottom: 10 }}>
                <button onClick={() => { setScreen("community"); setHubTab("prayer"); }} style={{ flex: 1, padding: 10, background: `${C.miracle}06`, border: `1px solid ${C.miracle}18`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 18 }}>🙏</div>
                  <div style={{ fontSize: 9, color: C.miracle, fontWeight: 600 }}>Prayer Wall</div>
                </button>
                <button onClick={briefing ? () => setShowBriefing(true) : generateBriefing} disabled={isLoading("briefing")} style={{ flex: 1, padding: 10, background: `${C.blue}06`, border: `1px solid ${C.blue}18`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 18 }}>📰</div>
                  <div style={{ fontSize: 9, color: C.blue, fontWeight: 600 }}>{briefing ? "Briefing" : "Get Briefing"}</div>
                </button>
                <button onClick={() => setScreen("sources")} style={{ flex: 1, padding: 10, background: `${C.purple}06`, border: `1px solid ${C.purple}18`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 18 }}>📚</div>
                  <div style={{ fontSize: 9, color: C.purple, fontWeight: 600 }}>Sources</div>
                </button>
                <button onClick={endSession} style={{ flex: 1, padding: 10, background: `${C.purple}06`, border: `1px solid ${C.purple}18`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 18 }}>✝</div>
                  <div style={{ fontSize: 9, color: C.purple, fontWeight: 600 }}>End + Pray</div>
                </button>
              </div>
            </div>
          )}

          {/* BIBLE */}
          {screen === "bible" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <button onClick={() => setScreen("home")} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 8px", fontFamily: font }}>← Back</button>

              {/* Passage input */}
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <input value={passage} onChange={e => { setPassage(e.target.value); setPassageError(null); }} placeholder="e.g. Romans 8:28, John 3:16" maxLength={300} style={{ ...inputS, flex: 1, borderColor: passageError ? C.red : C.border }} />
                <button onClick={() => loadBible()} style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}35`, color: C.blue, borderRadius: 8, padding: "0 14px", fontSize: 12, fontFamily: mono, cursor: "pointer" }}>Go</button>
              </div>
              {passageError && <p role="alert" style={{ fontSize: 11, color: C.red, margin: "0 0 6px" }}>⚠ {passageError}</p>}

              {/* Version selector + Compare toggle */}
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                <select value={bibleVersion} onChange={e => { setBibleVersion(e.target.value); if (passage && bibleText) loadBible(null, e.target.value); }} style={{ ...inputS, flex: 1, fontSize: 12, padding: "6px 8px", minWidth: 120 }}>
                  {BIBLE_VERSIONS.map(v => <option key={v.id} value={v.id}>{v.abbr} — {v.name} ({v.year})</option>)}
                </select>
                <button onClick={() => { if (compareVersion) { setCompareVersion(null); setCompareText(null); } else { const alt = bibleVersion === "kjv" ? "web" : "kjv"; setCompareVersion(alt); if (bibleText) loadBible(null, bibleVersion); } }} style={{ padding: "6px 12px", background: compareVersion ? `${C.blue}15` : C.surface, border: `1px solid ${compareVersion ? C.blue : C.border}`, borderRadius: 6, color: compareVersion ? C.blue : C.dim, fontSize: 10, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {compareVersion ? `✕ Compare` : `📊 Compare`}
                </button>
              </div>

              {/* Comparison version selector */}
              {compareVersion && (
                <select value={compareVersion} onChange={e => { setCompareVersion(e.target.value); if (bibleText) loadBible(null, bibleVersion); }} style={{ ...inputS, width: "100%", fontSize: 12, padding: "6px 8px", marginBottom: 10 }}>
                  {BIBLE_VERSIONS.filter(v => v.id !== bibleVersion).map(v => <option key={v.id} value={v.id}>{v.abbr} — {v.name}</option>)}
                </select>
              )}

              {isLoading("bible") && <p style={{ color: C.dim, textAlign: "center", padding: "20px 0" }}>Loading {BIBLE_VERSIONS.find(v=>v.id===bibleVersion)?.abbr}...</p>}

              {bibleText && !isLoading("bible") && (
                <>
                  {/* Main Bible text */}
                  <div style={{ ...cardS, padding: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <h2 style={{ fontSize: 15, fontWeight: 700, color: C.goldL, margin: 0 }}>📖 {bibleText.ref} <span style={{ fontSize: 10, color: C.dim, fontWeight: 400 }}>({bibleText.version || "KJV"})</span></h2>
                      <AddBtn label={`${bibleText.ref} (${bibleText.version || "KJV"})`} content={bibleText.text} />
                    </div>
                    {bibleText.verses?.length > 0 ? bibleText.verses.map((v, i) => (
                      <div key={i} style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <button onClick={() => { /* Cross-ref: tap verse number */ fetchSource("references"); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                          <span style={{ fontSize: 10, color: C.gold, fontFamily: mono, fontWeight: 700, minWidth: 18, paddingTop: 3 }}>{v.verse}</span>
                        </button>
                        <p style={{ fontSize: 15, color: C.text, margin: 0, lineHeight: 1.8, flex: 1 }}>
                          {v.text.split(/\s+/).map((word, wi) => (
                            <span key={wi}>
                              <span onClick={() => studyWord(word.replace(/[.,;:!?'"]/g, ''), `${bibleText.ref}:${v.verse}`)} style={{ cursor: "pointer", borderBottom: wordStudy?.word === word.replace(/[.,;:!?'"]/g, '') ? `2px solid ${C.gold}` : "none" }}>{word}</span>{" "}
                            </span>
                          ))}
                        </p>
                      </div>
                    )) : <p style={{ fontSize: 15, color: C.text, margin: 0, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{bibleText.text}</p>}
                    <p style={{ fontSize: 9, color: C.dim, marginTop: 8, textAlign: "center" }}>Tap any word for Greek/Hebrew study • Tap verse number for cross-references</p>
                  </div>

                  {/* Side-by-side comparison */}
                  {compareText && (
                    <div style={{ ...cardS, padding: 14, marginTop: 8, borderLeft: `3px solid ${C.blue}` }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, color: C.blue, margin: "0 0 8px" }}>📊 {compareText.ref} <span style={{ fontSize: 10, color: C.dim, fontWeight: 400 }}>({compareText.version})</span></h3>
                      {compareText.verses?.length > 0 ? compareText.verses.map((v, i) => (
                        <div key={i} style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ fontSize: 10, color: C.blue, fontFamily: mono, fontWeight: 700, minWidth: 18, paddingTop: 3 }}>{v.verse}</span>
                          <p style={{ fontSize: 14, color: C.text, margin: 0, lineHeight: 1.7, flex: 1 }}>{v.text}</p>
                        </div>
                      )) : <p style={{ fontSize: 14, color: C.text, margin: 0, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{compareText.text}</p>}
                      <AddBtn label={`${compareText.ref} (${compareText.version})`} content={compareText.text} />
                    </div>
                  )}

                  {/* Word Study panel — appears when a word is tapped */}
                  {wordStudy && (
                    <div style={{ ...cardS, padding: 14, marginTop: 8, borderLeft: `3px solid ${C.purple}`, background: `${C.purple}05` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>🔤 Word Study: "{wordStudy.word}"</span>
                        <button onClick={() => setWordStudy(null)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 14 }}>✕</button>
                      </div>
                      {wordStudy.loading && <p style={{ fontSize: 12, color: C.dim }}>Studying word...</p>}
                      {wordStudy.error && <p style={{ fontSize: 12, color: C.red }}>⚠ {wordStudy.error}</p>}
                      {wordStudy.data && (
                        <>
                          <div style={{ display: "flex", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                            <div style={{ background: `${C.purple}10`, borderRadius: 8, padding: "6px 10px" }}>
                              <div style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>ORIGINAL</div>
                              <div style={{ fontSize: 16, fontWeight: 700, color: C.purple }}>{wordStudy.data.original}</div>
                              <div style={{ fontSize: 10, color: C.dim }}>{wordStudy.data.transliteration}</div>
                            </div>
                            <div style={{ background: `${C.gold}10`, borderRadius: 8, padding: "6px 10px" }}>
                              <div style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>STRONG'S</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: C.gold, fontFamily: mono }}>{wordStudy.data.strongs}</div>
                              <div style={{ fontSize: 10, color: C.dim }}>{wordStudy.data.language}</div>
                            </div>
                          </div>
                          <p style={{ fontSize: 13, color: C.text, margin: "0 0 6px", lineHeight: 1.6 }}><strong>Definition:</strong> {wordStudy.data.definition}</p>
                          {wordStudy.data.root && <p style={{ fontSize: 12, color: C.dim, margin: "0 0 4px" }}>Root: {wordStudy.data.root}</p>}
                          <p style={{ fontSize: 12, color: C.text, margin: "0 0 6px", lineHeight: 1.5 }}><strong>In this context:</strong> {wordStudy.data.usage}</p>
                          <p style={{ fontSize: 12, color: C.gold, margin: "0 0 6px", fontStyle: "italic", lineHeight: 1.5 }}>↳ {wordStudy.data.theological}</p>
                          {wordStudy.data.other_occurrences?.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              <span style={{ fontSize: 10, color: C.dim, fontFamily: mono }}>ALSO FOUND IN:</span>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                                {wordStudy.data.other_occurrences.map((occ, i) => (
                                  <button key={i} onClick={() => { setPassage(occ); loadBible(occ); }} style={{ background: `${C.blue}10`, border: `1px solid ${C.blue}20`, borderRadius: 12, padding: "2px 8px", fontSize: 10, color: C.blue, cursor: "pointer" }}>{occ}</button>
                                ))}
                              </div>
                            </div>
                          )}
                          <AddBtn label={`Word: ${wordStudy.data.original} (${wordStudy.data.strongs})`} content={`${wordStudy.word} — ${wordStudy.data.original} (${wordStudy.data.transliteration}) ${wordStudy.data.strongs}: ${wordStudy.data.definition}\nTheological: ${wordStudy.data.theological}`} />
                          <button onClick={() => lookupFactbook(wordStudy.word)} disabled={isLoading("factbook")} style={{ width: "100%", marginTop: 6, padding: 8, background: `${C.blue}08`, border: `1px solid ${C.blue}20`, borderRadius: 6, color: C.blue, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{isLoading("factbook") ? "⏳ Looking up..." : `📘 Factbook: Who/What is "${wordStudy.word}"?`}</button>
                          <AIDisclaimer type="lexicon" />
                        </>
                      )}
                    </div>
                  )}

                  {/* Factbook panel */}
                  {factbookResult && (
                    <div style={{ ...cardS, padding: 14, marginTop: 8, borderLeft: `3px solid ${C.blue}`, background: `${C.blue}04` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>📘 {factbookResult.emoji} {factbookResult.term}</span>
                        <button onClick={() => setFactbookResult(null)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer" }}>✕</button>
                      </div>
                      <span style={{ ...tagS(C.blue), fontSize: 9 }}>{factbookResult.type}</span>
                      <p style={{ fontSize: 13, color: C.text, margin: "6px 0", lineHeight: 1.6 }}>{factbookResult.summary}</p>
                      {factbookResult.details && <div style={{ marginBottom: 6 }}>
                        {factbookResult.details.also_known_as && <p style={{ fontSize: 10, color: C.dim, margin: "2px 0" }}>Also known as: {factbookResult.details.also_known_as}</p>}
                        {factbookResult.details.era && <p style={{ fontSize: 10, color: C.dim, margin: "2px 0" }}>Era: {factbookResult.details.era}</p>}
                        <p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{factbookResult.details.significance}</p>
                      </div>}
                      {factbookResult.key_scriptures?.map((s,i) => <div key={i} style={{ background: `${C.gold}06`, borderRadius: 6, padding: 6, marginBottom: 3 }}><span style={{ fontSize: 10, color: C.gold, fontWeight: 700 }}>{s.ref}</span><span style={{ fontSize: 11, color: C.text, marginLeft: 6 }}>{s.context}</span></div>)}
                      {factbookResult.timeline?.length > 0 && <div style={{ marginTop: 6 }}><span style={{ fontSize: 9, color: C.dim, fontWeight: 700, fontFamily: mono }}>TIMELINE</span>{factbookResult.timeline.map((t,i) => <p key={i} style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>• {t.when}: {t.event}</p>)}</div>}
                      {factbookResult.did_you_know && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 6, marginTop: 6 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>DID YOU KNOW?</span><p style={{ fontSize: 11, color: C.text, margin: "2px 0 0" }}>{factbookResult.did_you_know}</p></div>}
                      {factbookResult.sermon_angle && <p style={{ fontSize: 10, color: C.purple, marginTop: 6 }}>🎤 Sermon angle: {factbookResult.sermon_angle}</p>}
                      <AddBtn label={`Factbook: ${factbookResult.term}`} content={`${factbookResult.term} (${factbookResult.type}): ${factbookResult.summary}\n\n${factbookResult.key_scriptures?.map(s=>s.ref+': '+s.context).join('\n')}\n\nSermon angle: ${factbookResult.sermon_angle}`} />
                    </div>
                  )}

                  {/* Quick actions */}
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <button onClick={() => addToDoc("scripture", `${bibleText.ref} (${bibleText.version || "KJV"})`, bibleText.text)} style={{ flex: 1, padding: 10, background: `${C.green}12`, border: `1px solid ${C.green}30`, borderRadius: 8, color: C.green, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Add to Sermon Notes</button>
                    <button onClick={() => setScreen("sources")} style={{ flex: 1, padding: 10, background: `${C.blue}12`, border: `1px solid ${C.blue}30`, borderRadius: 8, color: C.blue, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>📚 Sources</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* SOURCES */}
          {screen === "sources" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {!activeSource ? (
                <>
                  <button onClick={() => setScreen("home")} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 10px", fontFamily: font }}>← Back</button>
                  <h2 style={{ fontSize: 16, fontWeight: 600, color: C.goldL, margin: "0 0 4px" }}>📚 Sources for {passage}</h2>
                  <p style={{ fontSize: 11, color: C.dim, margin: "0 0 10px" }}>Tap any source to view it. Or select multiple and generate together.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {SOURCES.map(s => {
                      const selected = (selectedSources || []).includes(s.id);
                      return <button key={s.id} onClick={() => {
                        if (selectedSources && selectedSources.length > 0) {
                          // Multi-select mode
                          setSelectedSources(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id]);
                        } else {
                          // Single tap — load immediately
                          fetchSource(s.id);
                        }
                      }} onLongPress={() => setSelectedSources([s.id])}
                      aria-label={`Load ${s.label}`} style={{ ...cardS, cursor: "pointer", textAlign: "left", padding: "14px 10px", border: selected ? `2px solid ${C.gold}` : `1px solid ${C.border}`, background: selected ? `${C.gold}08` : C.card }}>
                        <div style={{ fontSize: 22, marginBottom: 4 }}>{s.icon}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.label}</div>
                      </button>;
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={() => setSelectedSources(selectedSources && selectedSources.length > 0 ? [] : SOURCES.map(s => s.id))} style={{ flex: 1, padding: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.dim, fontSize: 11, cursor: "pointer" }}>{selectedSources && selectedSources.length > 0 ? "Clear Selection" : "Select Multiple"}</button>
                    {selectedSources && selectedSources.length > 0 && (
                      <button onClick={async () => { for (const id of selectedSources) { await fetchSource(id); } setSelectedSources([]); }} style={{ flex: 1, padding: 8, background: C.gold, border: "none", borderRadius: 6, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Generate {selectedSources.length} Selected</button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button onClick={() => { setActiveSource(null); setSourceResult(null); setError(null); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 10px", fontFamily: font }}>← Sources</button>
                  {isLoading("source") && <p style={{ color: C.dim, textAlign: "center", padding: "30px 0" }}>Loading {SOURCES.find(s=>s.id===activeSource)?.label}...</p>}
                  {sourceResult && (
                    <div>
                      <h3 style={{ fontSize: 15, fontWeight: 600, color: SOURCES.find(s=>s.id===activeSource)?.color, margin: "0 0 10px" }}>{SOURCES.find(s=>s.id===activeSource)?.icon} {SOURCES.find(s=>s.id===activeSource)?.label}: {passage}</h3>
                      {activeSource === "commentary" && sourceResult.entries?.map((e,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 10, color: C.gold, fontFamily: mono, fontWeight: 700 }}>{e.verse}</span><p style={{ fontSize: 13, color: C.text, margin: "4px 0 0", lineHeight: 1.7 }}>{e.text}</p></div><AddBtn small label={`CMT ${e.verse}`} content={`${e.verse}: ${e.text}`} /></div></div>)}
                      {activeSource === "lexicon" && sourceResult.words?.map((w,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: C.goldL }}>{w.english}</div><div style={{ fontSize: 11, color: C.purple, fontFamily: mono }}>{w.original} ({w.transliteration}) • {w.strongs}</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{w.definition}</p>{w.theological_significance && <p style={{ fontSize: 11, color: C.gold, margin: 0, fontStyle: "italic" }}>↳ {w.theological_significance}</p>}</div><AddBtn small label={w.english} content={`${w.english} (${w.original}) ${w.strongs}: ${w.definition}`} /></div></div>)}
                      {activeSource === "compare" && sourceResult.translations?.map((t,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={tagS(C.blue)}>{t.version}</span><p style={{ fontSize: 14, color: C.text, margin: "6px 0", lineHeight: 1.7 }}>{t.text}</p>{t.note && <p style={{ fontSize: 10, color: C.dim, margin: 0, fontStyle: "italic" }}>{t.note}</p>}</div><AddBtn small label={t.version} content={`[${t.version}] ${t.text}`} /></div></div>)}
                      {activeSource === "dictionary" && sourceResult.entries?.map((e,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{e.term}</span><span style={{ fontSize: 9, color: C.red, fontFamily: mono, marginLeft: 6, textTransform: "uppercase" }}>{e.category}</span><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0", lineHeight: 1.6 }}>{e.definition}</p></div><AddBtn small label={e.term} content={`${e.term}: ${e.definition}`} /></div></div>)}
                      {activeSource === "references" && sourceResult.groups?.map((g,i) => <div key={i} style={{ marginBottom: 10 }}><div style={{ fontSize: 12, fontWeight: 600, color: C.blue, marginBottom: 4 }}>{g.theme}</div>{g.refs?.map((r,j) => <div key={j} style={{ ...cardS, display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 11, color: C.gold, fontFamily: mono, fontWeight: 700 }}>{r.ref}</span> <span style={{ fontSize: 11, color: C.dim }}>{r.connection}</span></div><AddBtn small label={r.ref} content={`${r.ref}: ${r.connection}`} /></div>)}</div>)}
                      {activeSource === "devotional" && <><div style={cardS}><div style={{ fontSize: 15, fontWeight: 600, color: C.green, marginBottom: 6 }}>{sourceResult.theme}</div><p style={{ fontSize: 13, color: C.text, margin: 0, lineHeight: 1.8, whiteSpace: "pre-line" }}>{sourceResult.reflection}</p></div>{sourceResult.prayer && <div style={{ ...cardS, borderLeft: `3px solid ${C.purple}` }}><span style={{ fontSize: 9, color: C.purple, fontFamily: mono, fontWeight: 700 }}>PRAYER</span><p style={{ fontSize: 13, color: C.text, margin: "4px 0 0", fontStyle: "italic", lineHeight: 1.7 }}>{sourceResult.prayer}</p></div>}</>}
                      <AIDisclaimer type={activeSource} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* RESULTS */}
          {screen === "results" && result && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {/* Sticky passage context bar */}
              <div style={{ background: `${C.gold}08`, border: `1px solid ${C.gold}20`, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.goldL }}>📖 {passage}</div>
                {sermonContext && <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>Context: {sermonContext}</div>}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={() => setScreen("home")} style={{ flex: 1, padding: 8, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.dim, fontSize: 12, cursor: "pointer", fontFamily: font }}>↩ New</button>
                <button onClick={() => { loadBible(); setScreen("bible"); }} style={{ flex: 1, padding: 8, background: `${C.blue}10`, border: `1px solid ${C.blue}25`, borderRadius: 6, color: C.blue, fontSize: 12, cursor: "pointer", fontFamily: font }}>📖 Read</button>
                <button onClick={() => setScreen("sources")} style={{ flex: 1, padding: 8, background: `${C.purple}10`, border: `1px solid ${C.purple}25`, borderRadius: 6, color: C.purple, fontSize: 12, cursor: "pointer", fontFamily: font }}>📚 Sources</button>
                {result.points && <button onClick={() => { if(!canAccess("podium")){showToast("Podium mode is a Shepherd feature. Upgrade to unlock.");return;} setPodiumSection(0); setScreen("podium"); }} style={{ flex: 1, padding: 8, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 6, color: C.gold, fontSize: 12, cursor: "pointer", fontFamily: font }}>📺 Podium</button>}
              </div>
              {/* Translate bar */}
              {lang !== "en" && (
                <button onClick={() => translateResult(lang)} disabled={isLoading("translate")} style={{ width: "100%", padding: 8, background: isLoading("translate")?C.card:`${C.blue}10`, border: `1px solid ${C.blue}25`, borderRadius: 6, color: isLoading("translate")?C.dim:C.blue, fontSize: 11, fontWeight: 600, cursor: isLoading("translate")?"default":"pointer", fontFamily: font, marginBottom: 10 }}>{isLoading("translate") ? "⏳ Translating..." : `🌍 Translate to ${LANGUAGES.find(l=>l.code===lang)?.native}`}</button>
              )}

              {resultType === "sermon" && result.title && (
                <>
                  <div style={{ borderLeft: `3px solid ${C.gold}`, paddingLeft: 12, marginBottom: 14 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: C.goldL, margin: "0 0 3px" }}>{result.title}</h2>
                    <p style={{ fontSize: 13, color: C.dim, margin: 0, fontStyle: "italic" }}>{result.big_idea}</p>
                  </div>
                  <div style={cardS}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 9, color: C.gold, fontFamily: mono, fontWeight: 700 }}>INTRODUCTION</span><AddBtn small label="Intro" content={`Hook: ${result.introduction?.hook}\nContext: ${result.introduction?.context}\nThesis: ${result.introduction?.thesis}`} /></div>
                    <p style={{ fontSize: 13, color: C.text, margin: "6px 0 3px", lineHeight: 1.7 }}>🎣 {result.introduction?.hook}</p>
                    <p style={{ fontSize: 12, color: C.dim, margin: "3px 0", lineHeight: 1.5 }}>{result.introduction?.context}</p>
                    <p style={{ fontSize: 13, color: C.goldL, margin: "3px 0 0", fontWeight: 500 }}>→ {result.introduction?.thesis}</p>
                  </div>
                  {result.points?.map((pt,i) => (
                    <div key={i} style={cardS}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                          <span style={{ width: 22, height: 22, borderRadius: "50%", background: `${C.gold}20`, border: `1.5px solid ${C.gold}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: C.gold, fontFamily: mono, flexShrink: 0 }}>{i+1}</span>
                          <div><div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{pt.heading}</div><div style={{ fontSize: 10, color: C.blue, fontFamily: mono }}>{pt.verses}</div></div>
                        </div>
                        <AddBtn small label={`Pt ${i+1}`} content={`${pt.heading} (${pt.verses})\n${pt.explanation}\n💡 ${pt.illustration}\n✋ ${pt.application}`} />
                      </div>
                      <p style={{ fontSize: 13, color: C.text, margin: "8px 0 4px", lineHeight: 1.7 }}>{pt.explanation}</p>
                      <p style={{ fontSize: 12, color: C.purple, margin: "0 0 3px" }}>💡 {pt.illustration}</p>
                      <p style={{ fontSize: 12, color: C.green, margin: 0 }}>✋ {pt.application}</p>
                    </div>
                  ))}
                  <div style={cardS}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 9, color: C.gold, fontFamily: mono, fontWeight: 700 }}>CONCLUSION</span><AddBtn small label="Conclusion" content={`${result.conclusion?.summary}\n${result.conclusion?.call}`} /></div>
                    <p style={{ fontSize: 13, color: C.text, margin: "6px 0 3px", lineHeight: 1.7 }}>{result.conclusion?.summary}</p>
                    <p style={{ fontSize: 13, color: C.goldL, margin: "3px 0", fontWeight: 500 }}>{result.conclusion?.call}</p>
                  </div>
                  {result.cross_refs?.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>{result.cross_refs.map((r,i) => <button key={i} onClick={() => addToDoc("ref", r, `Cross Ref: ${r}`)} style={{ ...tagS(C.blue), cursor: "pointer" }}>{r}</button>)}</div>}
                  {result.questions?.length > 0 && <div style={cardS}><span style={{ fontSize: 9, color: C.dim, fontFamily: mono, fontWeight: 700 }}>DISCUSSION</span>{result.questions.map((q,i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "5px 0 0" }}>{i+1}. {q}</p>)}</div>}
                  <AIDisclaimer type="sermon" />
                </>
              )}

              {resultType === "topical" && result.title && (
                <>
                  <div style={{ borderLeft: `3px solid ${C.blue}`, paddingLeft: 12, marginBottom: 14 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: "#93b4f5", margin: "0 0 3px" }}>{result.title}</h2>
                    <p style={{ fontSize: 13, color: C.dim, margin: 0 }}>{result.definition}</p>
                  </div>
                  {result.passages?.map((p,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 10, fontFamily: mono, fontWeight: 700, color: p.testament==="OT"?C.gold:C.blue }}>{p.ref}</span><p style={{ fontSize: 13, color: C.text, margin: "4px 0", lineHeight: 1.7 }}>{p.teaching}</p><p style={{ fontSize: 11, color: C.goldL, margin: 0, fontStyle: "italic" }}>💡 {p.insight}</p></div><AddBtn small label={p.ref} content={`${p.ref}: ${p.teaching}`} /></div></div>)}
                  {result.misconceptions?.map((m,i) => <div key={i} style={cardS}><p style={{ fontSize: 12, color: C.red, margin: "0 0 3px", textDecoration: "line-through", opacity: 0.7 }}>✕ {m.myth}</p><p style={{ fontSize: 12, color: C.green, margin: 0 }}>✓ {m.truth}</p></div>)}
                  {result.applications?.map((a,i) => <div key={i} style={cardS}><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{a.situation}</div><p style={{ fontSize: 12, color: C.dim, margin: "3px 0" }}>{a.principle}</p><p style={{ fontSize: 12, color: C.green, margin: 0 }}>→ {a.action}</p></div>)}
                  <AIDisclaimer type="topical" />
                </>
              )}
            </div>
          )}

          {/* DOCUMENT */}
          {screen === "document" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: C.goldL, margin: 0 }}>📄 Sermon Notes ({docBlocks.length})</h2>
                {docBlocks.length > 0 && <button onClick={exportDoc} aria-label="Export document" style={{ background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>📋 Export</button>}
              </div>
              <input value={docTitle} onChange={e => setDocTitle(e.target.value)} placeholder={`Study: ${passage}`} aria-label="Document title" style={{ ...inputS, fontSize: 16, fontWeight: 600, color: C.goldL, marginBottom: 10 }} />
              {docBlocks.length === 0 ? (
                <div style={{ textAlign: "center", padding: "20px 0", color: C.dim }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>📝</div>
                  <h3 style={{ fontSize: 15, fontWeight: 600, color: C.text, margin: "0 0 12px" }}>Build Your Sermon Here</h3>
                  {[
                    { step: "1", icon: "🎤", text: "Generate a sermon on the Prepare tab" },
                    { step: "2", icon: "➕", text: "Tap '+ Doc' on any section you want to keep" },
                    { step: "3", icon: "📖", text: "Read Bible text and add key verses" },
                    { step: "4", icon: "📚", text: "Browse Sources — add commentary and insights" },
                    { step: "5", icon: "✍️", text: "Write personal notes and reflections" },
                    { step: "6", icon: "✝", text: "Tap 'AI Compile' to build a preachable sermon" },
                  ].map(s => (
                    <div key={s.step} style={{ display: "flex", gap: 10, alignItems: "center", textAlign: "left", marginBottom: 8, padding: "6px 10px", background: C.surface, borderRadius: 8 }}>
                      <span style={{ fontSize: 14, width: 20, textAlign: "center" }}>{s.icon}</span>
                      <span style={{ fontSize: 12, color: C.text }}><strong style={{ color: C.gold }}>Step {s.step}:</strong> {s.text}</span>
                    </div>
                  ))}
                </div>
              ) : docBlocks.map((b, idx) => (
                <div key={b.id} style={{ ...cardS, borderLeft: `3px solid ${b.type==="note"?C.green:b.type==="scripture"?C.blue:C.gold}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontFamily: mono, fontWeight: 700, color: b.type==="note"?C.green:b.type==="scripture"?C.blue:C.gold }}>{b.label}</span>
                    <div style={{ display: "flex", gap: 3 }}>
                      {idx > 0 && <button onClick={() => moveBlock(b.id,-1)} aria-label="Move up" style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13 }}>↑</button>}
                      {idx < docBlocks.length-1 && <button onClick={() => moveBlock(b.id,1)} aria-label="Move down" style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13 }}>↓</button>}
                      <button onClick={() => { setEditingId(b.id); setEditText(b.content); }} aria-label="Edit" style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 10, fontFamily: mono }}>edit</button>
                      <button onClick={() => removeBlock(b.id)} aria-label="Remove block" style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}>✕</button>
                    </div>
                  </div>
                  {editingId === b.id ? (
                    <>
                      <textarea value={editText} onChange={e => setEditText(e.target.value)} aria-label="Edit content" style={{ ...inputS, minHeight: 80, fontSize: 13, resize: "vertical" }} />
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button onClick={() => saveEdit(b.id)} style={{ flex: 1, padding: 7, background: `${C.green}12`, border: `1px solid ${C.green}25`, borderRadius: 6, color: C.green, fontSize: 11, cursor: "pointer", fontFamily: mono }}>✓ Save</button>
                        <button onClick={() => setEditingId(null)} style={{ flex: 1, padding: 7, background: `${C.red}08`, border: `1px solid ${C.red}25`, borderRadius: 6, color: C.red, fontSize: 11, cursor: "pointer", fontFamily: mono }}>Cancel</button>
                      </div>
                    </>
                  ) : <p style={{ fontSize: 13, color: C.text, margin: 0, lineHeight: 1.7, whiteSpace: "pre-line" }}>{b.content}</p>}
                </div>
              ))}
              <div style={{ marginTop: 12 }}>
                <div style={secH}>Personal Note</div>
                <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Notes, reflections..." maxLength={INPUT_LIMITS.sermonBody} aria-label="Add note" style={{ ...inputS, minHeight: 60, fontSize: 13, resize: "vertical" }} />
                <button onClick={() => { if(noteText.trim()) { addToDoc("note","Note",noteText); setNoteText(""); }}} disabled={!noteText.trim()} style={{ width: "100%", marginTop: 6, padding: 10, background: noteText.trim()?`${C.green}12`:C.card, border: `1px solid ${noteText.trim()?`${C.green}25`:C.border}`, borderRadius: 8, color: noteText.trim()?C.green:C.dim, fontSize: 13, fontWeight: 600, cursor: noteText.trim()?"pointer":"default", fontFamily: font }}>✍️ Add Note</button>
              </div>
              {docBlocks.length >= 2 && (
                <div style={{ marginTop: 14 }}>
                  <button onClick={compileSermon} disabled={isLoading("compile")} style={{ width: "100%", padding: 14, background: isLoading("compile") ? C.card : `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 10, color: isLoading("compile") ? C.dim : "#fff", fontSize: 15, fontWeight: 700, cursor: isLoading("compile") ? "default" : "pointer", fontFamily: font }}>
                    {isLoading("compile") ? "⏳ AI Compiling Sermon..." : "✝ AI Compile into Full Sermon"}
                  </button>
                  <p style={{ fontSize: 10, color: C.dim, textAlign: "center", marginTop: 4 }}>AI reads all your notes and generates a complete, preachable sermon</p>
                </div>
              )}
              {compiledSermon && (
                <div style={{ marginTop: 14, ...cardS, borderLeft: `3px solid ${C.gold}`, background: `${C.gold}05` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.gold }}>✝ Compiled Sermon</span>
                    <button onClick={() => { navigator.clipboard?.writeText(compiledSermon); showToast("📋 Sermon copied!"); }} style={{ background: C.gold, border: "none", color: "#fff", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Copy</button>
                  </div>
                  <p style={{ fontSize: 14, color: C.text, margin: 0, lineHeight: 1.9, whiteSpace: "pre-line" }}>{compiledSermon}</p>
                </div>
              )}
              {docBlocks.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                  <button onClick={exportDoc} style={{ flex: 1, padding: 12, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: font }}>📋 Copy</button>
                  <button onClick={() => saveToArchive({})} style={{ flex: 1, padding: 12, background: `${C.blue}10`, border: `1px solid ${C.blue}25`, borderRadius: 8, color: C.blue, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: font }}>📚 Archive</button>
                  <button onClick={() => { if(confirm("Clear all blocks?")) { setDocBlocks([]); setCompiledSermon(null); } }} style={{ padding: "12px 14px", background: `${C.red}08`, border: `1px solid ${C.red}25`, borderRadius: 8, color: C.red, fontSize: 12, cursor: "pointer", fontFamily: mono }}>🗑️</button>
                </div>
              )}

              {/* Sermon Archive viewer */}
              <div style={{ marginTop: 14 }}>
                <button onClick={() => setShowArchive(!showArchive)} style={{ width: "100%", padding: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.dim, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{showArchive ? "✕ Close Archive" : `📚 Sermon Archive (${sermonArchive.length})`}</button>
                {showArchive && sermonArchive.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {sermonArchive.slice(0, 20).map(s => (
                      <div key={s.id} style={{ ...cardS, padding: 10, marginBottom: 4, cursor: "pointer" }} onClick={() => { setCompiledSermon(s.content); showToast(`Loaded: ${s.title}`); }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{s.title}</span>
                          <span style={{ fontSize: 9, color: C.dim }}>{s.date}</span>
                        </div>
                        <div style={{ fontSize: 10, color: C.gold }}>{s.passage}</div>
                      </div>
                    ))}
                  </div>
                )}
                {showArchive && sermonArchive.length === 0 && <p style={{ fontSize: 11, color: C.dim, textAlign: "center", marginTop: 6 }}>No archived sermons yet. Compile a sermon and tap "Archive" to save it.</p>}
              </div>
            </div>
          )}

          {/* COMMUNITY HUB */}
          {screen === "community" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {!shareMode && !viewSermon && (
                <>
                  <div style={{ textAlign: "center", marginBottom: 8 }}>
                    <h2 style={{ fontSize: 17, fontWeight: 700, color: C.goldL, margin: 0 }}>🕊️ Faith Community</h2>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: C.gold, fontWeight: 700, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Worship & Study</div>
                    <div style={{ display: "flex", gap: 5, marginBottom: 8, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      {[{id:"prayer",icon:"🙏",l:"Prayer"},{id:"sermons",icon:"🎤",l:"Sermons"},{id:"songs",icon:"🎵",l:"Music"},{id:"illustrations",icon:"💡",l:"Illustr."},{id:"media",icon:"🎬",l:"Media & Learn"}].map(t => (
                        <button key={t.id} role="tab" aria-selected={hubTab===t.id} onClick={() => setHubTab(t.id)} style={{ padding: "6px 12px", background: hubTab===t.id?`${C.gold}15`:C.card, border: hubTab===t.id?`1px solid ${C.gold}35`:`1px solid ${C.border}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 13 }}>{t.icon}</span><span style={{ fontSize: 10, fontWeight: hubTab===t.id?700:400, color: hubTab===t.id?C.goldL:C.dim }}>{t.l}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: C.green, fontWeight: 700, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Next Generation</div>
                    <div style={{ display: "flex", gap: 5, marginBottom: 8, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      {[{id:"kids",icon:"🌟",l:"Kids"},{id:"teens",icon:"🔥",l:"Teens"},{id:"mentorship",icon:"🤝",l:"Mentors"},{id:"games",icon:"🎮",l:"Games"},{id:"family",icon:"👨‍👩‍👧‍👦",l:"Family"}].map(t => (
                        <button key={t.id} role="tab" aria-selected={hubTab===t.id} onClick={() => setHubTab(t.id)} style={{ padding: "6px 12px", background: hubTab===t.id?`${C.green}15`:C.card, border: hubTab===t.id?`1px solid ${C.green}35`:`1px solid ${C.border}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 13 }}>{t.icon}</span><span style={{ fontSize: 10, fontWeight: hubTab===t.id?700:400, color: hubTab===t.id?C.green:C.dim }}>{t.l}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: C.blue, fontWeight: 700, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Church Life</div>
                    <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                      {[{id:"events",icon:"📅",l:"Events"},{id:"charity",icon:"💛",l:"Charity"}].map(t => (
                        <button key={t.id} role="tab" aria-selected={hubTab===t.id} onClick={() => setHubTab(t.id)} style={{ padding: "6px 12px", background: hubTab===t.id?`${C.blue}15`:C.card, border: hubTab===t.id?`1px solid ${C.blue}35`:`1px solid ${C.border}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 13 }}>{t.icon}</span><span style={{ fontSize: 10, fontWeight: hubTab===t.id?700:400, color: hubTab===t.id?C.blue:C.dim }}>{t.l}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: C.green, fontWeight: 700, fontFamily: mono, textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>Wellness</div>
                    <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                      {[{id:"wellness",icon:"🌿",l:"Healthy Soul"}].map(t => (
                        <button key={t.id} role="tab" aria-selected={hubTab===t.id} onClick={() => setHubTab(t.id)} style={{ padding: "6px 12px", background: hubTab===t.id?`${C.green}15`:C.card, border: hubTab===t.id?`1px solid ${C.green}35`:`1px solid ${C.border}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 13 }}>{t.icon}</span><span style={{ fontSize: 10, fontWeight: hubTab===t.id?700:400, color: hubTab===t.id?C.green:C.dim }}>{t.l}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* PRAYER POWER MAP */}
                  {hubTab === "prayer" && <>
                    <div style={{ textAlign: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🙏</div>
                      <h3 style={{ fontSize: 17, fontWeight: 700, color: C.goldL, margin: "0 0 2px" }}>The Power of Prayer</h3>
                      <p style={{ fontSize: 11, color: C.dim, margin: "0 0 8px" }}>United in prayer — 24 hours, every timezone, one voice</p>
                      <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
                        <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 700, color: C.miracle, fontFamily: mono }}>{activePrayerCount}</div><div style={{ fontSize: 9, color: C.dim }}>prayers today</div></div>
                        <div style={{ width: 1, background: C.border }}/>
                        <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 700, color: C.gold, fontFamily: mono }}>{PRAYER_ZONES.filter(z => getZoneStatus(z.offset).glow).length}</div><div style={{ fontSize: 9, color: C.dim }}>zones awake</div></div>
                        <div style={{ width: 1, background: C.border }}/>
                        <div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 700, color: C.purple, fontFamily: mono }}>{prayers.reduce((s,p) => s + (p.prayedBy||0), 0)}</div><div style={{ fontSize: 9, color: C.dim }}>joined</div></div>
                      </div>
                    </div>

                    {/* 24-Hour Prayer Clock */}
                    <div style={{ ...cardS, padding: 12, background: C.warm, border: `1px solid ${C.gold}20` }}>
                      <div style={{ fontSize: 9, fontFamily: mono, color: C.gold, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, textAlign: "center" }}>🌍 24-Hour Prayer Clock — {prayerMapTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {PRAYER_ZONES.map((zone, i) => {
                          const st = getZoneStatus(zone.offset);
                          const utcH = prayerMapTime.getUTCHours() + prayerMapTime.getUTCMinutes()/60;
                          const lh = Math.floor((utcH + zone.offset + 24) % 24);
                          const lm = String(Math.floor((((utcH + zone.offset + 24) % 1) * 60))).padStart(2, "0");
                          return (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 5px", borderRadius: 5, background: st.glow ? `${st.color}08` : "transparent", border: `1px solid ${st.glow ? `${st.color}18` : "transparent"}` }}>
                              <span style={{ fontSize: 13, width: 18, textAlign: "center" }}>{zone.emoji}</span>
                              <div style={{ flex: 1, fontSize: 10, fontWeight: 600, color: st.glow ? C.text : C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{zone.name}</div>
                              <span style={{ fontSize: 9, fontFamily: mono, color: st.color, minWidth: 36, textAlign: "right" }}>{lh}:{lm.slice(0,2)}</span>
                              <span style={{ fontSize: 7, color: st.color, fontFamily: mono, minWidth: 46, textAlign: "right" }}>{st.label}</span>
                              {st.glow && <div style={{ width: 5, height: 5, borderRadius: "50%", background: st.color, boxShadow: `0 0 6px ${st.color}80`, flexShrink: 0 }}/>}
                            </div>
                          );
                        })}
                      </div>
                      <p style={{ fontSize: 8, color: "#374151", textAlign: "center", margin: "6px 0 0", fontStyle: "italic" }}>The prayer chain never breaks — someone is always praying</p>
                    </div>

                    {/* Submit Prayer */}
                    <button onClick={() => setShowPrayerForm(!showPrayerForm)} style={{ width: "100%", marginTop: 8, padding: 11, background: showPrayerForm ? C.card : `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: showPrayerForm ? `1px solid ${C.border}` : "none", borderRadius: 8, color: showPrayerForm ? C.dim : "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: font }}>{showPrayerForm ? "✕ Cancel" : "🙏 Submit a Prayer Request"}</button>

                    {showPrayerForm && (
                      <div style={{ ...cardS, padding: 12, marginTop: 6, borderColor: `${C.gold}25` }}>
                        <textarea value={prayerForm.text} onChange={e => setPrayerForm(f=>({...f,text:e.target.value}))} placeholder="What's on your heart?" maxLength={INPUT_LIMITS.comment} aria-label="Prayer request" style={{ ...inputS, minHeight: 60, fontSize: 13, resize: "vertical", marginBottom: 6 }} />
                        <input value={prayerForm.name} onChange={e => setPrayerForm(f=>({...f,name:e.target.value}))} placeholder="Your name (optional)" maxLength={100} style={{ ...inputS, marginBottom: 6, fontSize: 12 }} />
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
                          {PRAYER_CATEGORIES.filter(c=>c.id!=="all"&&c.id!=="urgent").map(c => (
                            <button key={c.id} onClick={() => setPrayerForm(f=>({...f,category:c.id}))} style={{ background: prayerForm.category===c.id?`${c.color}18`:C.surface, border: `1px solid ${prayerForm.category===c.id?`${c.color}35`:C.border}`, color: prayerForm.category===c.id?c.color:C.dim, borderRadius: 12, padding: "3px 7px", fontSize: 8, cursor: "pointer" }}>{c.label}</button>
                          ))}
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.red, marginBottom: 6, cursor: "pointer" }}><input type="checkbox" checked={prayerForm.urgent} onChange={e => setPrayerForm(f=>({...f,urgent:e.target.checked}))} /> 🔴 Urgent</label>
                        <button onClick={submitPrayer} disabled={!prayerForm.text.trim()} style={{ width: "100%", padding: 10, background: prayerForm.text.trim()?`linear-gradient(135deg, ${C.gold}, #a0832e)`:C.card, border: "none", borderRadius: 8, color: prayerForm.text.trim()?"#fff":C.dim, fontSize: 12, fontWeight: 700, cursor: prayerForm.text.trim()?"pointer":"default", fontFamily: font }}>🙏 Submit Prayer</button>
                      </div>
                    )}

                    {/* Global Prayer Focuses */}
                    <div style={secH}>🌍 Global Prayer Focuses</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                      {GLOBAL_PRAYER_FOCUSES.map(f => (
                        <button key={f.id} onClick={() => { setPrayerForm(p => ({...p, text: `Praying for ${f.title}: ${f.desc}`, category: "nations"})); setShowPrayerForm(true); }} style={{ ...cardS, cursor: "pointer", padding: 8, textAlign: "left", borderLeft: `3px solid ${f.color}` }}>
                          <div style={{ fontSize: 16, marginBottom: 2 }}>{f.icon}</div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text, lineHeight: 1.2 }}>{f.title}</div>
                          <div style={{ fontSize: 8, color: C.dim, marginTop: 1 }}>{f.region}</div>
                          <div style={{ fontSize: 7, color: f.color, fontFamily: mono, marginTop: 1 }}>📖 {f.verse}</div>
                        </button>
                      ))}
                    </div>

                    {/* Prayer Wall */}
                    <div style={secH}>🙏 Prayer Wall — Last 24 Hours</div>
                    <div style={{ display: "flex", gap: 3, overflowX: "auto", marginBottom: 6, WebkitOverflowScrolling: "touch" }}>
                      {PRAYER_CATEGORIES.map(c => (
                        <button key={c.id} onClick={() => setPrayerFilter(c.id)} style={{ padding: "3px 7px", background: prayerFilter===c.id?`${c.color}15`:C.surface, border: `1px solid ${prayerFilter===c.id?`${c.color}30`:C.border}`, borderRadius: 10, fontSize: 8, color: prayerFilter===c.id?c.color:C.dim, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{c.label}</button>
                      ))}
                    </div>

                    {filteredPrayers.length === 0 ? (
                      <div style={{ textAlign: "center", padding: "16px 0", color: C.dim }}><p style={{ fontSize: 11 }}>{prayerFilter==="all"?"No prayers yet. Be the first to lift your voice.":"No prayers in this category."}</p></div>
                    ) : filteredPrayers.map(p => (
                      <div key={p.id} style={{ ...cardS, padding: 10, borderLeft: `3px solid ${p.urgent ? C.red : PRAYER_CATEGORIES.find(c=>c.id===p.category)?.color || C.gold}` }}>
                        <div style={{ flex: 1 }}>
                          {p.urgent && <span style={{ fontSize: 7, color: "#fff", background: C.red, padding: "1px 4px", borderRadius: 3, fontFamily: mono, fontWeight: 700, marginRight: 3 }}>URGENT</span>}
                          <span style={{ fontSize: 9, color: C.dim }}>{p.name} • {p.displayTime}</span>
                          <p style={{ fontSize: 12, color: C.text, margin: "3px 0 0", lineHeight: 1.5 }}>{p.text}</p>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5 }}>
                          <span style={{ fontSize: 9, color: C.purple }}>{p.prayedBy || 0} praying</span>
                          <button onClick={() => prayForRequest(p.id)} aria-label="Join prayer" style={{ background: `${C.purple}12`, border: `1px solid ${C.purple}30`, color: C.purple, padding: "3px 10px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: font }}>🙏 I'm Praying</button>
                        </div>
                      </div>
                    ))}

                    <div style={{ ...cardS, textAlign: "center", marginTop: 6, background: `${C.gold}06`, borderColor: `${C.gold}20`, padding: 12 }}>
                      <p style={{ fontSize: 13, color: C.text, margin: "0 0 3px", fontStyle: "italic", lineHeight: 1.5 }}>"If two of you shall agree on earth as touching any thing that they shall ask, it shall be done for them of my Father which is in heaven."</p>
                      <span style={{ fontSize: 9, color: C.gold, fontFamily: mono }}>— Matthew 18:19 KJV</span>
                    </div>
                  </>}

                  {/* SERMONS */}
                  {hubTab === "sermons" && <>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      <button onClick={() => { setShareForm({author:user?.name||"",church:"",title:"",passage:"",body:"",tags:[]}); setShareMode("compose"); }} style={{ flex: 1, padding: 10, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: font }}>✍️ Write</button>
                      {result && resultType==="sermon" && <button onClick={shareCurrentSermon} style={{ flex: 1, padding: 10, background: `${C.miracle}12`, border: `1px solid ${C.miracle}30`, borderRadius: 8, color: C.miracle, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: font }}>⚡ Share Current</button>}
                    </div>
                    {sortedSermons.length === 0 ? <p style={{ textAlign: "center", color: C.dim, padding: "20px 0", fontSize: 12 }}>No sermons yet. Be the first!</p> : sortedSermons.map(s => (
                      <button key={s.id} onClick={() => { setViewSermon(s); setShareMode("view"); }} style={{ width: "100%", textAlign: "left", cursor: "pointer", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, marginBottom: 5, display: "block" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.goldL }}>{s.title}</div>
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 1 }}>{s.author} • {s.displayDate}</div>
                        <div style={{ display: "flex", gap: 8, fontSize: 10, marginTop: 4 }}><span style={{ color: "#f87171" }}>❤️ {s.reactions?.love||0}</span><span style={{ color: "#a78bfa" }}>🙏 {s.reactions?.pray||0}</span><span style={{ color: C.gold }}>🙌 {s.reactions?.amen||0}</span></div>
                      </button>
                    ))}
                  </>}

                  {/* SONGS */}
                  {hubTab === "songs" && <>
                    <div style={{ textAlign: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🎵</div>
                      <h3 style={{ fontSize: 17, fontWeight: 700, color: C.purple, margin: "0 0 2px", fontFamily: font }}>Worship & Music</h3>
                      <p style={{ fontSize: 11, color: C.dim, margin: 0 }}>"Sing unto the LORD a new song" — Psalm 96:1</p>
                    </div>

                    {/* Music mode selector */}
                    <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                      {[
                        { id: "write", icon: "✍️", label: "Write Song" },
                        { id: "plan", icon: "📋", label: "Worship Set" },
                        { id: "discover", icon: "🎧", label: "Discover" },
                      ].map(m => (
                        <button key={m.id} onClick={() => setMusicMode(m.id)} style={{ flex: 1, padding: "8px 4px", background: musicMode===m.id ? `${C.purple}12` : C.card, border: `1px solid ${musicMode===m.id ? C.purple : C.border}`, borderRadius: 8, cursor: "pointer", textAlign: "center" }}>
                          <div style={{ fontSize: 16 }}>{m.icon}</div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: musicMode===m.id ? C.purple : C.dim }}>{m.label}</div>
                        </button>
                      ))}
                    </div>

                    {/* WRITE SONG MODE */}
                    {musicMode === "write" && <>
                      <div style={{ ...cardS, padding: 14, textAlign: "center" }}>
                        <h4 style={{ fontSize: 14, fontWeight: 700, color: C.purple, margin: "0 0 6px" }}>✍️ AI Worship Song Writer</h4>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6, justifyContent: "center" }}>
                          {["Grace","Worship","Surrender","Hope","Victory","Lament","Thanksgiving","Healing","Praise","The Cross"].map(s => (
                            <button key={s} onClick={() => setSongRequest(s)} style={{ padding: "3px 8px", background: songRequest===s?`${C.purple}15`:C.surface, border: `1px solid ${songRequest===s?C.purple:C.border}`, borderRadius: 12, fontSize: 9, color: songRequest===s?C.purple:C.dim, cursor: "pointer" }}>{s}</button>
                          ))}
                        </div>
                        <input value={songRequest} onChange={e => setSongRequest(e.target.value)} placeholder="Or type your own theme..." maxLength={INPUT_LIMITS.songReq} style={{ ...inputS, marginBottom: 6, textAlign: "center", fontSize: 11 }} />
                        <button onClick={generateSong} disabled={isLoading("song")||!songRequest.trim()} style={{ width: "100%", padding: 10, background: isLoading("song")?C.card:`linear-gradient(135deg, ${C.purple}, #7c3aed)`, border: "none", borderRadius: 8, color: isLoading("song")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("song")?"default":"pointer", fontFamily: font }}>{isLoading("song")?"⏳ Writing...":"🎵 Generate Song"}</button>
                      </div>
                      {songResult && <div style={{ ...cardS, padding: 14 }}><h4 style={{ fontSize: 15, fontWeight: 700, color: C.goldL, margin: "0 0 6px" }}>🎵 {songResult.title}</h4>{songResult.verses?.map((v,i) => <div key={i} style={{ marginBottom: 8, paddingLeft: 10, borderLeft: v.label?.toLowerCase().includes("chorus")?`3px solid ${C.gold}`:`2px solid ${C.border}` }}><div style={{ fontSize: 9, fontFamily: mono, color: v.label?.toLowerCase().includes("chorus")?C.gold:C.dim, fontWeight: 700, marginBottom: 3 }}>{v.label}</div>{v.lines?.map((l,j) => <p key={j} style={{ fontSize: 14, color: C.text, margin: "1px 0", lineHeight: 1.6 }}>{l}</p>)}</div>)}<AddBtn label={songResult.title} content={songResult.verses?.map(v=>v.label+':\n'+v.lines?.join('\n')).join('\n\n')} /><AIDisclaimer type="song" /></div>}
                    </>}

                    {/* WORSHIP SET PLANNER */}
                    {musicMode === "plan" && <>
                      <div style={{ ...cardS, padding: 14 }}>
                        <h4 style={{ fontSize: 14, fontWeight: 700, color: C.purple, margin: "0 0 4px" }}>📋 Worship Set Planner</h4>
                        <p style={{ fontSize: 11, color: C.dim, margin: "0 0 6px" }}>AI builds a complete worship set matched to your sermon</p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                          {passage && <button onClick={() => setWorshipPlanQuery(passage)} style={{ padding: "3px 8px", background: `${C.gold}15`, border: `1px solid ${C.gold}`, borderRadius: 12, fontSize: 9, color: C.gold, cursor: "pointer", fontWeight: 700 }}>📖 {passage}</button>}
                          {["God's faithfulness","Salvation","The Cross","Holy Spirit","Prayer","Unity","Missions","Grace","Hope","Resurrection"].map(s => (
                            <button key={s} onClick={() => setWorshipPlanQuery(s)} style={{ padding: "3px 8px", background: worshipPlanQuery===s?`${C.purple}15`:C.surface, border: `1px solid ${worshipPlanQuery===s?C.purple:C.border}`, borderRadius: 12, fontSize: 9, color: worshipPlanQuery===s?C.purple:C.dim, cursor: "pointer" }}>{s}</button>
                          ))}
                        </div>
                        <input value={worshipPlanQuery} onChange={e => setWorshipPlanQuery(e.target.value)} placeholder="Or type your sermon topic..." maxLength={300} style={{ ...inputS, marginBottom: 6, fontSize: 11 }} />
                        <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                          {["contemporary","traditional","blended","youth","gospel"].map(s => (
                            <button key={s} onClick={() => setWorshipStyle(s)} style={{ flex: 1, padding: "4px 2px", background: worshipStyle===s ? `${C.purple}12` : C.surface, border: `1px solid ${worshipStyle===s ? C.purple : C.border}`, borderRadius: 6, fontSize: 8, fontWeight: 600, color: worshipStyle===s ? C.purple : C.dim, cursor: "pointer", textTransform: "capitalize" }}>{s}</button>
                          ))}
                        </div>
                        <button onClick={generateWorshipPlan} disabled={isLoading("worshipPlan")||!worshipPlanQuery.trim()} style={{ width: "100%", padding: 10, background: isLoading("worshipPlan")?C.card:`linear-gradient(135deg, ${C.purple}, #7c3aed)`, border: "none", borderRadius: 8, color: isLoading("worshipPlan")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("worshipPlan")?"default":"pointer" }}>{isLoading("worshipPlan")?"⏳ Planning...":"📋 Build Worship Set"}</button>
                      </div>
                      {worshipPlan && <div style={{ ...cardS, padding: 14, borderLeft: `3px solid ${C.purple}` }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: C.purple, marginBottom: 2 }}>🎵 {worshipPlan.theme}</div>
                        <div style={{ fontSize: 10, color: C.dim, marginBottom: 8 }}>{worshipPlan.style} • {worshipPlan.duration}</div>
                        {worshipPlan.set_list?.map((song,i) => (
                          <div key={i} style={{ background: C.surface, borderRadius: 8, padding: 10, marginBottom: 6, borderLeft: `3px solid ${song.moment==="opening"?C.green:song.moment==="response"?C.gold:song.moment==="communion"?C.red:song.moment==="closing"?C.blue:C.purple}` }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{song.title}</div>
                                <div style={{ fontSize: 10, color: C.dim }}>{song.artist} • {song.moment}</div>
                              </div>
                              <a href={`https://open.spotify.com/search/${encodeURIComponent(song.title + ' ' + song.artist)}`} target="_blank" rel="noopener" style={{ background: "#1DB954", color: "#fff", padding: "4px 8px", borderRadius: 12, fontSize: 9, fontWeight: 700, textDecoration: "none" }}>▶ Spotify</a>
                            </div>
                            <p style={{ fontSize: 10, color: C.gold, margin: "4px 0 0", fontStyle: "italic" }}>📖 {song.scripture_connection}</p>
                            {song.key && <span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>Key: {song.key} • Tempo: {song.tempo}</span>}
                          </div>
                        ))}
                        {worshipPlan.flow_notes && <div style={{ background: `${C.purple}06`, borderRadius: 6, padding: 8, marginTop: 6 }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>FLOW NOTES</span><p style={{ fontSize: 11, color: C.text, margin: "2px 0 0" }}>{worshipPlan.flow_notes}</p></div>}
                        {worshipPlan.prayer_transitions && <div style={{ marginTop: 6 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>PRAYER TRANSITIONS</span>{worshipPlan.prayer_transitions.map((p,i) => <p key={i} style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>🙏 {p}</p>)}</div>}
                        <AddBtn label={`Worship Set: ${worshipPlan.theme}`} content={worshipPlan.set_list?.map((s,i)=>`${i+1}. ${s.title} — ${s.artist} (${s.moment}) [${s.scripture_connection}]`).join('\n')} />
                        <AIDisclaimer type="worship" />
                      </div>}
                    </>}

                    {/* DISCOVER MODE — Christian artists + Spotify links */}
                    {musicMode === "discover" && <>
                      <div style={{ ...cardS, padding: 14 }}>
                        <h4 style={{ fontSize: 14, fontWeight: 700, color: C.purple, margin: "0 0 4px" }}>🎧 Discover Christian Music</h4>
                        <p style={{ fontSize: 11, color: C.dim, margin: "0 0 6px" }}>Find artists and songs for your mood, sermon, or season</p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
                          {["Uplifting","Contemplative","Energetic","Peaceful","Powerful","Intimate","Grief & comfort","Celebration","Acoustic","Youth worship"].map(s => (
                            <button key={s} onClick={() => setDiscoverQuery(s)} style={{ padding: "3px 8px", background: discoverQuery===s?`${C.purple}15`:C.surface, border: `1px solid ${discoverQuery===s?C.purple:C.border}`, borderRadius: 12, fontSize: 9, color: discoverQuery===s?C.purple:C.dim, cursor: "pointer" }}>{s}</button>
                          ))}
                        </div>
                        <input value={discoverQuery} onChange={e => setDiscoverQuery(e.target.value)} placeholder="Or describe what you want..." maxLength={200} style={{ ...inputS, marginBottom: 6, fontSize: 11 }} />
                        <button onClick={discoverMusic} disabled={isLoading("discover")||!discoverQuery.trim()} style={{ width: "100%", padding: 10, background: isLoading("discover")?C.card:`linear-gradient(135deg, ${C.purple}, #7c3aed)`, border: "none", borderRadius: 8, color: isLoading("discover")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("discover")?"default":"pointer" }}>{isLoading("discover")?"⏳ Discovering...":"🎧 Find Music"}</button>
                      </div>
                      {discoverResult && <div>
                        {discoverResult.recommendations?.map((rec,i) => (
                          <div key={i} style={{ ...cardS, display: "flex", gap: 10, alignItems: "center" }}>
                            <div style={{ fontSize: 28, flexShrink: 0 }}>{rec.emoji || "🎵"}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{rec.song}</div>
                              <div style={{ fontSize: 11, color: C.purple }}>{rec.artist}</div>
                              <div style={{ fontSize: 10, color: C.dim }}>{rec.genre} • {rec.mood}</div>
                              <p style={{ fontSize: 10, color: C.gold, margin: "2px 0 0", fontStyle: "italic" }}>📖 {rec.scripture_vibe}</p>
                            </div>
                            <a href={`https://open.spotify.com/search/${encodeURIComponent(rec.song + ' ' + rec.artist)}`} target="_blank" rel="noopener" style={{ background: "#1DB954", color: "#fff", padding: "6px 10px", borderRadius: 16, fontSize: 10, fontWeight: 700, textDecoration: "none", flexShrink: 0 }}>▶</a>
                          </div>
                        ))}
                        {discoverResult.playlist_idea && <div style={{ ...cardS, background: `${C.purple}06` }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>PLAYLIST IDEA</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>{discoverResult.playlist_idea}</p></div>}
                        <AIDisclaimer type="music" />
                      </div>}
                    </>}
                  </>}

                  {/* ILLUSTRATIONS */}
                  {hubTab === "illustrations" && <>
                    <div style={{ ...cardS, padding: 14, background: `${C.gold}06` }}>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: C.goldL, margin: "0 0 6px", textAlign: "center" }}>💡 Sermon Illustrations</h3>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4, justifyContent: "center" }}>
                        {passage && <button onClick={() => setIllusSearch(passage)} style={{ padding: "3px 8px", background: `${C.gold}15`, border: `1px solid ${C.gold}`, borderRadius: 12, fontSize: 9, color: C.gold, cursor: "pointer", fontWeight: 700 }}>📖 {passage}</button>}
                        {["Faith","Grace","Forgiveness","Patience","Love","Sacrifice","Hope","Perseverance","Prayer","Trust"].map(s => (
                          <button key={s} onClick={() => setIllusSearch(s)} style={{ padding: "3px 8px", background: illusSearch===s?`${C.gold}15`:C.surface, border: `1px solid ${illusSearch===s?C.gold:C.border}`, borderRadius: 12, fontSize: 9, color: illusSearch===s?C.gold:C.dim, cursor: "pointer" }}>{s}</button>
                        ))}
                      </div>
                      <input value={illusSearch} onChange={e => setIllusSearch(e.target.value)} placeholder="Or type your own topic..." maxLength={INPUT_LIMITS.songReq} style={{ ...inputS, marginBottom: 6, textAlign: "center", fontSize: 11 }} />
                      <button onClick={() => generateIllustrations(illusSearch)} disabled={isLoading("illus")||!illusSearch.trim()} style={{ width: "100%", padding: 10, background: isLoading("illus")?C.card:`linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: isLoading("illus")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("illus")?"default":"pointer", fontFamily: font }}>{isLoading("illus")?"⏳ Generating...":"💡 Generate 6 Illustrations"}</button>
                    </div>
                    {illusResult && <div>{illusResult.illustrations?.map((il,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{il.title}</span><span style={{ fontSize: 8, color: C.dim, fontFamily: mono, marginLeft: 4 }}>{il.type?.replace("_"," ")}</span><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.6 }}>{il.content}</p><span style={{ fontSize: 9, color: C.gold }}>📖 {il.scripture_tie}</span></div><AddBtn small label={il.title} content={`${il.title}\n\n${il.content}\n\nScripture: ${il.scripture_tie}`} /></div></div>)}<AIDisclaimer type="illustration" /></div>}
                    {illustrations.length > 0 && <><div style={secH}>Library ({illustrations.length})</div>{filteredIllustrations.slice(0,15).map((il,i) => <div key={il.id||i} style={{ ...cardS, padding: 10 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{il.title}</span><p style={{ fontSize: 11, color: C.dim, margin: "2px 0 0", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{il.content}</p></div><AddBtn small label={il.title} content={il.content} /></div></div>)}</>}
                  </>}

                  {/* MEDIA & LEARN */}
                  {hubTab === "media" && <>
                    <div style={{ textAlign: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🎬</div>
                      <h3 style={{ fontSize: 17, fontWeight: 700, color: C.blue, margin: "0 0 2px", fontFamily: font }}>Media & Learn</h3>
                      <p style={{ fontSize: 11, color: C.dim, margin: 0 }}>Videos, virtual tours, courses, and sermon visuals</p>
                    </div>

                    <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                      {[
                        { id: "explore", icon: "🎥", label: "Watch & Learn" },
                        { id: "tour", icon: "🌍", label: "Virtual Tour" },
                        { id: "course", icon: "🎓", label: "Mini Course" },
                        { id: "visuals", icon: "📊", label: "Sermon Visuals" },
                      ].map(m => (
                        <button key={m.id} onClick={() => { setMediaMode(m.id); setMediaResult(null); setMediaQuery(""); }} style={{ flex: 1, padding: "8px 2px", background: mediaMode===m.id ? `${C.blue}12` : C.card, border: `1px solid ${mediaMode===m.id ? C.blue : C.border}`, borderRadius: 8, cursor: "pointer", textAlign: "center" }}>
                          <div style={{ fontSize: 16 }}>{m.icon}</div>
                          <div style={{ fontSize: 8, fontWeight: 600, color: mediaMode===m.id ? C.blue : C.dim }}>{m.label}</div>
                        </button>
                      ))}
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      {/* Per-mode preset chips */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                        {(mediaMode === "explore" ? ["Revelation","Paul's Journeys","Archaeology","Early Church","Dead Sea Scrolls","Creation","Exodus"]
                        : mediaMode === "tour" ? ["Jerusalem","Bethlehem","Sea of Galilee","Rome","Ephesus","Mount Sinai","Corinth","Nazareth"]
                        : mediaMode === "course" ? ["Book of Romans","Prayer","Church History","Intro to Greek","Apologetics","Spiritual Gifts","Parables"]
                        : ["Grace","The Cross","Psalm 23","Resurrection","Forgiveness","Faith","Love","Hope"]
                        ).map(s => (
                          <button key={s} onClick={() => setMediaQuery(s)} style={{ padding: "3px 8px", background: mediaQuery===s?`${C.blue}15`:C.surface, border: `1px solid ${mediaQuery===s?C.blue:C.border}`, borderRadius: 12, fontSize: 9, color: mediaQuery===s?C.blue:C.dim, cursor: "pointer" }}>{s}</button>
                        ))}
                      </div>
                      <input value={mediaQuery} onChange={e => setMediaQuery(e.target.value)} placeholder="Or type your own topic..." maxLength={300} style={{ ...inputS, fontSize: 11, marginBottom: 6 }} />
                      <button onClick={() => generateMedia(mediaMode, mediaQuery)} disabled={isLoading("media")||!mediaQuery.trim()} style={{ width: "100%", padding: 10, background: isLoading("media")?C.card:`linear-gradient(135deg, ${C.blue}, #1e4f7a)`, border: "none", borderRadius: 8, color: isLoading("media")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("media")?"default":"pointer" }}>
                        {isLoading("media") ? "⏳ Loading..." : mediaMode === "explore" ? "🎥 Find Media" : mediaMode === "tour" ? "🌍 Start Tour" : mediaMode === "course" ? "🎓 Build Course" : "📊 Plan Visuals"}
                      </button>
                    </div>

                    {/* EXPLORE results */}
                    {mediaResult && mediaMode === "explore" && <div>
                      {mediaResult.documentaries?.length > 0 && <>
                        <div style={{ fontSize: 10, color: C.blue, fontWeight: 700, fontFamily: mono, marginBottom: 4 }}>🎬 DOCUMENTARIES & FILMS</div>
                        {mediaResult.documentaries.map((d,i) => (
                          <div key={i} style={{ ...cardS, display: "flex", gap: 8, alignItems: "center" }}>
                            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{d.title}</div><div style={{ fontSize: 10, color: C.dim }}>{d.creator} • {d.year} • {d.duration}</div><p style={{ fontSize: 11, color: C.text, margin: "2px 0", lineHeight: 1.4 }}>{d.description}</p><span style={{ fontSize: 9, color: C.gold }}>📖 {d.scripture_connection}</span></div>
                            <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(d.url_hint)}`} target="_blank" rel="noopener" style={{ background: "#FF0000", color: "#fff", padding: "6px 8px", borderRadius: 8, fontSize: 9, fontWeight: 700, textDecoration: "none", flexShrink: 0 }}>▶ YT</a>
                          </div>
                        ))}
                      </>}
                      {mediaResult.youtube_channels?.length > 0 && <>
                        <div style={{ fontSize: 10, color: C.red, fontWeight: 700, fontFamily: mono, marginTop: 8, marginBottom: 4 }}>📺 YOUTUBE CHANNELS</div>
                        {mediaResult.youtube_channels.map((ch,i) => (
                          <div key={i} style={{ ...cardS }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{ch.name}</div>
                            <div style={{ fontSize: 10, color: C.dim }}>{ch.subscribers} subscribers • {ch.focus}</div>
                            <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(ch.name + ' ' + ch.best_video)}`} target="_blank" rel="noopener" style={{ fontSize: 11, color: C.blue, textDecoration: "underline" }}>▶ Watch: {ch.best_video}</a>
                          </div>
                        ))}
                      </>}
                      {mediaResult.podcasts?.length > 0 && <>
                        <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, fontFamily: mono, marginTop: 8, marginBottom: 4 }}>🎙️ PODCASTS</div>
                        {mediaResult.podcasts.map((p,i) => (
                          <div key={i} style={{ ...cardS }}><div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{p.name}</div><div style={{ fontSize: 10, color: C.dim }}>Hosted by {p.host} • {p.platform}</div><p style={{ fontSize: 10, color: C.gold, margin: "2px 0 0" }}>▶ Try: {p.episode_suggestion}</p></div>
                        ))}
                      </>}
                      {mediaResult.learning_path && <div style={{ ...cardS, background: `${C.blue}06` }}><span style={{ fontSize: 9, color: C.blue, fontWeight: 700, fontFamily: mono }}>LEARNING PATH</span><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0", lineHeight: 1.6, whiteSpace: "pre-line" }}>{mediaResult.learning_path}</p></div>}
                    </div>}

                    {/* VIRTUAL TOUR results */}
                    {mediaResult && mediaMode === "tour" && <div style={{ ...cardS, borderLeft: `3px solid ${C.green}` }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.green, marginBottom: 2 }}>🌍 {mediaResult.location}</div>
                      <div style={{ fontSize: 10, color: C.dim }}>{mediaResult.modern_name} • {mediaResult.era}</div>
                      {mediaResult.bible_references?.map((r,i) => <div key={i} style={{ background: `${C.gold}06`, borderRadius: 6, padding: 6, marginTop: 6 }}><span style={{ fontSize: 10, color: C.gold, fontWeight: 700 }}>{r.ref}</span><span style={{ fontSize: 11, color: C.text, marginLeft: 6 }}>{r.event}</span></div>)}
                      <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginTop: 10, marginBottom: 4 }}>TOUR STOPS</div>
                      {mediaResult.tour_stops?.map((s,i) => (
                        <div key={i} style={{ background: C.surface, borderRadius: 8, padding: 10, marginBottom: 6 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>📍 {s.stop}</div>
                          <p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.6 }}>{s.description}</p>
                          <p style={{ fontSize: 10, color: C.blue, margin: "2px 0" }}>🏛️ {s.historical_note}</p>
                          <p style={{ fontSize: 10, color: C.gold, margin: "2px 0", fontStyle: "italic" }}>📖 {s.scripture}</p>
                        </div>
                      ))}
                      {mediaResult.google_earth_search && <a href={`https://earth.google.com/web/search/${encodeURIComponent(mediaResult.google_earth_search)}`} target="_blank" rel="noopener" style={{ display: "block", padding: 10, background: `${C.green}10`, border: `1px solid ${C.green}25`, borderRadius: 8, color: C.green, fontSize: 12, fontWeight: 600, textDecoration: "none", textAlign: "center", marginTop: 8 }}>🌐 Open in Google Earth</a>}
                      {mediaResult.prayer && <div style={{ background: `${C.purple}06`, borderRadius: 6, padding: 8, marginTop: 8 }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>PRAYER AT THIS PLACE</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{mediaResult.prayer}</p></div>}
                      <AddBtn label={`Virtual Tour: ${mediaResult.location}`} content={`Tour of ${mediaResult.location}\n\n${mediaResult.tour_stops?.map((s,i)=>`Stop ${i+1}: ${s.stop}\n${s.description}\n${s.scripture}`).join('\n\n')}`} />
                    </div>}

                    {/* MINI COURSE results */}
                    {mediaResult && mediaMode === "course" && <div style={{ ...cardS, borderLeft: `3px solid ${C.purple}` }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.purple, marginBottom: 2 }}>🎓 {mediaResult.course_title}</div>
                      <div style={{ fontSize: 10, color: C.dim }}>{mediaResult.level} • {mediaResult.duration}</div>
                      <p style={{ fontSize: 12, color: C.text, margin: "6px 0 10px", lineHeight: 1.5 }}>{mediaResult.description}</p>
                      {mediaResult.lessons?.map((lesson,i) => (
                        <div key={i} style={{ background: C.surface, borderRadius: 10, padding: 12, marginBottom: 8 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                            <div style={{ width: 28, height: 28, borderRadius: 14, background: C.purple, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{lesson.lesson_number}</div>
                            <div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{lesson.title}</div><div style={{ fontSize: 9, color: C.dim }}>📖 {lesson.key_passage}</div></div>
                          </div>
                          <p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.6, whiteSpace: "pre-line" }}>{lesson.content}</p>
                          <div style={{ marginTop: 4 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>DISCUSS</span>{lesson.discussion_questions?.map((q,j) => <p key={j} style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>💬 {q}</p>)}</div>
                          <p style={{ fontSize: 10, color: C.green, marginTop: 4 }}>✅ Do: {lesson.practical_application}</p>
                          {lesson.video_suggestion && <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(lesson.video_suggestion)}`} target="_blank" rel="noopener" style={{ fontSize: 10, color: C.blue, textDecoration: "underline" }}>▶ Watch: {lesson.video_suggestion}</a>}
                        </div>
                      ))}
                      {mediaResult.final_project && <div style={{ background: `${C.gold}06`, borderRadius: 8, padding: 10, marginTop: 6 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>FINAL PROJECT</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>{mediaResult.final_project}</p></div>}
                      <AddBtn label={`Course: ${mediaResult.course_title}`} content={`${mediaResult.course_title}\n\n${mediaResult.lessons?.map(l=>`Lesson ${l.lesson_number}: ${l.title}\n${l.content}`).join('\n\n')}`} />
                    </div>}

                    {/* SERMON VISUALS results */}
                    {mediaResult && mediaMode === "visuals" && <div style={{ ...cardS, borderLeft: `3px solid ${C.gold}` }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.gold, marginBottom: 2 }}>📊 Sermon Visual Plan</div>
                      {mediaResult.title_slide && <div style={{ background: C.surface, borderRadius: 8, padding: 10, marginBottom: 6 }}><div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{mediaResult.title_slide.title}</div><div style={{ fontSize: 11, color: C.dim }}>{mediaResult.title_slide.subtitle}</div><p style={{ fontSize: 10, color: C.blue, margin: "2px 0" }}>🎨 {mediaResult.title_slide.visual}</p></div>}
                      {mediaResult.slides?.map((s,i) => (
                        <div key={i} style={{ background: C.surface, borderRadius: 8, padding: 8, marginBottom: 4, borderLeft: `2px solid ${C.gold}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Slide {s.slide_number}: {s.heading}</span></div>
                          <p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>{s.content}</p>
                          <p style={{ fontSize: 9, color: C.blue }}>🎨 {s.visual_note}</p>
                        </div>
                      ))}
                      {mediaResult.video_moments?.map((v,i) => <div key={i} style={{ background: `${C.red}06`, borderRadius: 6, padding: 6, marginTop: 4 }}><span style={{ fontSize: 9, color: C.red, fontWeight: 700, fontFamily: mono }}>🎬 VIDEO: {v.moment}</span><p style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>{v.suggestion}</p><a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(v.youtube_search)}`} target="_blank" rel="noopener" style={{ fontSize: 9, color: C.blue }}>▶ Find on YouTube</a></div>)}
                      {mediaResult.presentation_tips && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginTop: 8 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>TIPS</span><p style={{ fontSize: 11, color: C.text, margin: "2px 0 0" }}>{mediaResult.presentation_tips}</p></div>}
                      <AddBtn label="Sermon Visual Plan" content={mediaResult.slides?.map(s=>`Slide ${s.slide_number}: ${s.heading}\n${s.content}\nVisual: ${s.visual_note}`).join('\n\n')} />
                    </div>}

                    {isLoading("media") && <div style={{ textAlign: "center", padding: "30px 0" }}><div style={{ fontSize: 32, marginBottom: 8, animation: "float 1.5s ease infinite" }}>🎬</div><p style={{ color: C.dim, fontSize: 13 }}>Discovering content...</p></div>}
                    <AIDisclaimer type="media" />
                  </>}

                  {/* KIDS & TEENS CORNER */}
                  {hubTab === "kids" && <>
                    <div style={{ textAlign: "center", marginBottom: 12 }}>
                      <div style={{ fontSize: 32, marginBottom: 4 }}>🌟</div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "0 0 2px", fontFamily: font }}>Kids & Teens Corner</h3>
                      <p style={{ fontSize: 12, color: C.dim, margin: "0 0 10px" }}>Fun, faith-filled learning for young believers</p>
                      {/* Age Group Selector */}
                      <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 12 }}>
                        {[{id:"4-6",label:"4-6 yrs"},{id:"6-9",label:"6-9 yrs"},{id:"10-12",label:"10-12"},{id:"13-17",label:"Teens"}].map(a => (
                          <button key={a.id} onClick={() => setKidsAgeGroup(a.id)} style={{ padding: "6px 12px", background: kidsAgeGroup===a.id?`${C.gold}12`:C.card, border: `1px solid ${kidsAgeGroup===a.id?`${C.gold}30`:C.border}`, borderRadius: 20, fontSize: 11, fontWeight: kidsAgeGroup===a.id?700:400, color: kidsAgeGroup===a.id?C.gold:C.dim, cursor: "pointer", fontFamily: sans }}>{a.label}</button>
                        ))}
                      </div>
                    </div>

                    {!kidsMode ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        {KIDS_MODES.map(m => (
                          <button key={m.id} onClick={() => generateKidsContent(m.id)} style={{ ...cardS, cursor: "pointer", textAlign: "center", padding: 16, borderLeft: `3px solid ${m.color}` }}>
                            <div style={{ fontSize: 28, marginBottom: 4 }}>{m.icon}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{m.title}</div>
                            <div style={{ fontSize: 10, color: C.dim, marginTop: 2, lineHeight: 1.3 }}>{m.desc}</div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <>
                        <button onClick={() => { setKidsMode(null); setKidsResult(null); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 8px", fontFamily: sans }}>← Back to activities</button>

                        {isLoading("kids") && <div style={{ textAlign: "center", padding: "30px 0" }}><div style={{ fontSize: 32, marginBottom: 8, animation: "float 1.5s ease infinite" }}>{KIDS_MODES.find(m=>m.id===kidsMode)?.icon || "🌟"}</div><p style={{ color: C.dim, fontSize: 13 }}>Creating something special...</p></div>}

                        {kidsResult && (
                          <div style={{ animation: "fadeUp 0.3s ease" }}>
                            {/* STORY */}
                            {kidsMode === "story" && <>
                              <div style={{ ...cardS, padding: 18, background: C.warm, textAlign: "center" }}>
                                <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>{kidsResult.title}</h3>
                                <span style={{ fontSize: 11, color: C.blue, fontFamily: sans }}>📖 {kidsResult.bible_ref}</span>
                                {kidsResult.characters?.length > 0 && <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 8 }}>{kidsResult.characters.map((ch,i) => <div key={i} style={{ textAlign: "center" }}><div style={{ fontSize: 24 }}>{ch.emoji}</div><div style={{ fontSize: 9, color: C.dim }}>{ch.name}</div></div>)}</div>}
                              </div>
                              {kidsResult.story_parts?.map((part,i) => (
                                <div key={i} style={{ ...cardS, padding: 14, borderLeft: `3px solid ${C.gold}` }}>
                                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ fontSize: 22 }}>{part.emoji}</span><div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{part.heading}</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0 0", lineHeight: 1.7 }}>{part.text}</p></div></div>
                                </div>
                              ))}
                              <div style={{ ...cardS, padding: 14, background: `${C.green}08`, borderColor: `${C.green}20` }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>💡 What We Learn</div>
                                <p style={{ fontSize: 13, color: C.text, margin: "4px 0 0", lineHeight: 1.5 }}>{kidsResult.moral}</p>
                              </div>
                              {kidsResult.prayer && <div style={{ ...cardS, padding: 14, background: `${C.purple}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🙏 Let's Pray</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", fontStyle: "italic", lineHeight: 1.6 }}>{kidsResult.prayer}</p></div>}
                              {kidsResult.discussion?.length > 0 && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>💬 Talk About It</div>{kidsResult.discussion.map((q,i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "4px 0 0" }}>{i+1}. {q}</p>)}</div>}
                            </>}

                            {/* QUIZ */}
                            {kidsMode === "quiz" && kidsResult.questions && <>
                              <div style={{ ...cardS, padding: 14, textAlign: "center", background: C.warm }}><h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: 0, fontFamily: font }}>{kidsResult.emoji} {kidsResult.title}</h3></div>
                              {kidsResult.questions.map((q,i) => (
                                <div key={i} style={{ ...cardS, padding: 14 }}>
                                  <p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "0 0 8px" }}>{i+1}. {q.q}</p>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                                    {q.options.map((o,j) => <button key={j} onClick={()=>{}} style={{ padding: "8px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text, cursor: "pointer", textAlign: "left", fontFamily: sans }}>{o}</button>)}
                                  </div>
                                  <p style={{ fontSize: 10, color: C.dim, margin: "6px 0 0", fontStyle: "italic" }}>💡 {q.fun_fact}</p>
                                </div>
                              ))}
                            </>}

                            {/* MEMORY VERSE */}
                            {kidsMode === "memory" && <>
                              <div style={{ ...cardS, padding: 16, textAlign: "center", background: C.warm }}>
                                <div style={{ fontSize: 11, color: C.purple, fontFamily: sans, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Memory Verse</div>
                                <p style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "8px 0 4px", fontFamily: font, lineHeight: 1.5 }}>"{kidsResult.verse_text}"</p>
                                <span style={{ fontSize: 12, color: C.gold }}>— {kidsResult.verse_ref}</span>
                              </div>
                              {kidsResult.fill_blanks?.map((fb,i) => <div key={i} style={{ ...cardS, padding: 12 }}><p style={{ fontSize: 14, color: C.text, margin: 0 }}>{fb.display}</p><p style={{ fontSize: 12, color: C.green, margin: "4px 0 0", fontWeight: 600 }}>Answer: {fb.answer}</p></div>)}
                              {kidsResult.hand_motions && <div style={{ ...cardS, padding: 12 }}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>🤲 Hand Motions</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0", lineHeight: 1.5 }}>{kidsResult.hand_motions}</p></div>}
                              {kidsResult.activity && <div style={{ ...cardS, padding: 12 }}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>🎯 Activity</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0", lineHeight: 1.5 }}>{kidsResult.activity}</p></div>}
                            </>}

                            {/* CRAFT */}
                            {kidsMode === "craft" && <>
                              <div style={{ ...cardS, padding: 16, textAlign: "center", background: C.warm }}><h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>✂️ {kidsResult.title}</h3><p style={{ fontSize: 12, color: C.dim, margin: 0 }}>{kidsResult.bible_connection}</p></div>
                              {kidsResult.materials?.length > 0 && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>🛒 You'll Need</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0" }}>{kidsResult.materials.join(" • ")}</p></div>}
                              {kidsResult.steps?.map((s,i) => <div key={i} style={{ ...cardS, padding: 12, display: "flex", gap: 8 }}><div style={{ width: 24, height: 24, borderRadius: "50%", background: `${C.blue}12`, border: `1px solid ${C.blue}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.blue, flexShrink: 0 }}>{s.step}</div><div><p style={{ fontSize: 13, color: C.text, margin: 0, lineHeight: 1.5 }}>{s.instruction}</p>{s.tip && <p style={{ fontSize: 10, color: C.dim, margin: "2px 0 0", fontStyle: "italic" }}>💡 {s.tip}</p>}</div></div>)}
                              {kidsResult.verse && <div style={{ ...cardS, padding: 12, textAlign: "center", background: `${C.gold}06` }}><p style={{ fontSize: 12, color: C.gold, margin: 0, fontStyle: "italic" }}>📖 {kidsResult.verse}</p></div>}
                            </>}

                            {/* HERO */}
                            {kidsMode === "hero" && <>
                              <div style={{ ...cardS, padding: 16, textAlign: "center", background: C.warm }}><div style={{ fontSize: 36 }}>{kidsResult.emoji}</div><h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "4px 0 2px", fontFamily: font }}>{kidsResult.name}</h3><p style={{ fontSize: 12, color: C.dim, margin: 0 }}>{kidsResult.title} • {kidsResult.era}</p><span style={{ fontSize: 10, color: C.blue }}>📖 {kidsResult.bible_ref}</span></div>
                              <div style={{ ...cardS, padding: 14 }}><p style={{ fontSize: 13, color: C.text, margin: 0, lineHeight: 1.8, whiteSpace: "pre-line" }}>{kidsResult.story}</p></div>
                              {kidsResult.superpowers?.length > 0 && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>⚡ Special Powers</div>{kidsResult.superpowers.map((sp,i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "4px 0 0" }}>{sp.emoji} {sp.power}</p>)}</div>}
                              {kidsResult.god_moment && <div style={{ ...cardS, padding: 12, borderLeft: `3px solid ${C.green}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>✨ God Moment</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{kidsResult.god_moment}</p></div>}
                              {kidsResult.challenge && <div style={{ ...cardS, padding: 12, background: `${C.gold}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>🎯 Your Challenge This Week</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{kidsResult.challenge}</p></div>}
                            </>}

                            {/* LESSON */}
                            {kidsMode === "lesson" && <>
                              <div style={{ ...cardS, padding: 16, textAlign: "center", background: C.warm }}><h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: 0, fontFamily: font }}>💡 {kidsResult.title}</h3></div>
                              <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>📋 The Situation</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", lineHeight: 1.6 }}>{kidsResult.scenario}</p></div>
                              {kidsResult.wrong_choice && <div style={{ ...cardS, borderLeft: `3px solid ${C.red}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.red }}>❌ What Most Kids Do</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0" }}>{kidsResult.wrong_choice.action}</p><p style={{ fontSize: 11, color: C.dim, margin: "2px 0 0" }}>{kidsResult.wrong_choice.result}</p></div>}
                              {kidsResult.wwjd && <div style={{ ...cardS, borderLeft: `3px solid ${C.green}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>✅ What Jesus Would Do</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0" }}>{kidsResult.wwjd.action}</p><p style={{ fontSize: 11, color: C.gold, margin: "2px 0 0" }}>📖 {kidsResult.wwjd.verse}</p></div>}
                              {kidsResult.take_home && <div style={{ ...cardS, padding: 12, textAlign: "center", background: `${C.gold}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>💎 Remember This</div><p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "4px 0", lineHeight: 1.4 }}>{kidsResult.take_home}</p></div>}
                            </>}

                            <button onClick={() => generateKidsContent(kidsMode)} style={{ width: "100%", marginTop: 8, padding: 12, background: C.gold, border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>🔄 Generate New {KIDS_MODES.find(m=>m.id===kidsMode)?.title}</button>
                            <AIDisclaimer type="kids" />
                          </div>
                        )}
                      </>
                    )}
                  </>}

                  {/* TEEN HUB — The Bridge */}
                  {hubTab === "teens" && <>
                    <div style={{ textAlign: "center", marginBottom: 12 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🔥</div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "0 0 2px", fontFamily: font }}>Teen Hub</h3>
                      <p style={{ fontSize: 12, color: C.dim, margin: "0 0 4px" }}>Real faith for real life — no filter</p>
                      <p style={{ fontSize: 10, color: C.gold, fontStyle: "italic" }}>"Don't let anyone look down on you because you are young" — 1 Timothy 4:12</p>
                    </div>

                    {!teenMode ? (
                      <>
                        {/* Activity Cards */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                          {TEEN_MODES.map(m => (
                            <button key={m.id} onClick={() => generateTeenContent(m.id)} style={{ ...cardS, cursor: "pointer", textAlign: "center", padding: 16, borderLeft: `3px solid ${m.color}` }}>
                              <div style={{ fontSize: 26, marginBottom: 4 }}>{m.icon}</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{m.title}</div>
                              <div style={{ fontSize: 10, color: C.dim, marginTop: 2, lineHeight: 1.3 }}>{m.desc}</div>
                            </button>
                          ))}
                        </div>

                        {/* Mentorship Bridge */}
                        <div style={{ ...cardS, padding: 16, background: C.warm, borderColor: `${C.gold}25` }}>
                          <h4 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>🌉 The Mentorship Bridge</h4>
                          <p style={{ fontSize: 11, color: C.dim, margin: "0 0 10px", lineHeight: 1.5 }}>Teens mentor kids. Elders mentor teens. Everyone grows together.</p>
                          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                            {MENTOR_TYPES.map(mt => (
                              <div key={mt.id} style={{ flex: 1, textAlign: "center", padding: "8px 4px", background: C.card, borderRadius: 10, border: `1px solid ${C.border}` }}>
                                <div style={{ fontSize: 18, marginBottom: 2 }}>{mt.icon}</div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: mt.color }}>{mt.label}</div>
                                <div style={{ fontSize: 8, color: C.dim, marginTop: 1 }}>{mt.desc}</div>
                              </div>
                            ))}
                          </div>
                          <button onClick={() => setShowMentorForm(!showMentorForm)} style={{ width: "100%", padding: 10, background: C.gold, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>{showMentorForm ? "Cancel" : "✍️ Share Wisdom or Encouragement"}</button>
                        </div>

                        {/* Mentor Post Form */}
                        {showMentorForm && (
                          <div style={{ ...cardS, padding: 14, marginTop: 6, animation: "fadeUp 0.3s ease" }}>
                            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                              {MENTOR_TYPES.map(mt => (
                                <button key={mt.id} onClick={() => setMentorForm(f=>({...f,type:mt.id}))} style={{ flex: 1, padding: "6px 4px", background: mentorForm.type===mt.id?`${mt.color}10`:C.surface, border: `1px solid ${mentorForm.type===mt.id?`${mt.color}30`:C.border}`, borderRadius: 8, fontSize: 9, fontWeight: mentorForm.type===mt.id?700:400, color: mentorForm.type===mt.id?mt.color:C.dim, cursor: "pointer" }}>{mt.icon} {mt.label}</button>
                              ))}
                            </div>
                            <input value={mentorForm.name} onChange={e => setMentorForm(f=>({...f,name:e.target.value}))} placeholder="Your name" maxLength={100} style={{ ...inputS, marginBottom: 6, fontSize: 12 }} />
                            <textarea value={mentorForm.text} onChange={e => setMentorForm(f=>({...f,text:e.target.value}))} placeholder={mentorForm.type==="teen-to-kid"?"Share something you learned that could help a younger believer...":mentorForm.type==="elder-to-teen"?"Share wisdom, encouragement, or a life lesson for a teen...":"Share what you're learning on your faith journey..."} maxLength={INPUT_LIMITS.comment} style={{ ...inputS, minHeight: 70, fontSize: 13, resize: "vertical", marginBottom: 6 }} />
                            <button onClick={submitMentorPost} disabled={!mentorForm.text.trim()} style={{ width: "100%", padding: 10, background: mentorForm.text.trim()?C.gold:C.surface, border: "none", borderRadius: 8, color: mentorForm.text.trim()?"#fff":C.dim, fontSize: 12, fontWeight: 700, cursor: mentorForm.text.trim()?"pointer":"default", fontFamily: sans }}>Share</button>
                          </div>
                        )}

                        {/* Mentor Wall */}
                        {mentorPosts.length > 0 && <>
                          <div style={secH}>🌉 Mentorship Wall</div>
                          {mentorPosts.slice(0, 20).map(post => {
                            const mt = MENTOR_TYPES.find(t=>t.id===post.type);
                            return (
                              <div key={post.id} style={{ ...cardS, padding: 12, borderLeft: `3px solid ${mt?.color || C.gold}` }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                  <div>
                                    <span style={{ fontSize: 12 }}>{mt?.icon || "🌟"}</span>
                                    <span style={{ fontSize: 10, fontWeight: 600, color: mt?.color || C.gold, marginLeft: 4 }}>{mt?.label || "Mentor"}</span>
                                    <span style={{ fontSize: 9, color: C.dim, marginLeft: 6 }}>{post.name} • {post.displayDate}</span>
                                  </div>
                                  <button onClick={() => heartMentorPost(post.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.red }}>❤️ {post.hearts || 0}</button>
                                </div>
                                <p style={{ fontSize: 13, color: C.text, margin: 0, lineHeight: 1.6 }}>{post.text}</p>
                              </div>
                            );
                          })}
                        </>}
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setTeenMode(null); setTeenResult(null); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 8px", fontFamily: sans }}>← Back to Teen Hub</button>

                        {isLoading("teen") && <div style={{ textAlign: "center", padding: "30px 0" }}><div style={{ fontSize: 32, marginBottom: 8, animation: "float 1.5s ease infinite" }}>{TEEN_MODES.find(m=>m.id===teenMode)?.icon || "🔥"}</div><p style={{ color: C.dim, fontSize: 13 }}>Creating something real...</p></div>}

                        {teenResult && (
                          <div style={{ animation: "fadeUp 0.3s ease" }}>
                            {/* DEVOTION */}
                            {teenMode === "devotion" && <>
                              <div style={{ ...cardS, padding: 18, background: C.warm }}><h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "0 0 6px", fontFamily: font }}>{teenResult.title}</h3><p style={{ fontSize: 14, color: C.text, margin: 0, lineHeight: 1.6 }}>{teenResult.hook}</p></div>
                              {teenResult.scripture && <div style={{ ...cardS, padding: 14, borderLeft: `3px solid ${C.gold}` }}><span style={{ fontSize: 10, fontWeight: 600, color: C.gold }}>{teenResult.scripture.ref}</span><p style={{ fontSize: 15, color: C.text, margin: "4px 0", fontFamily: font, fontStyle: "italic", lineHeight: 1.7 }}>"{teenResult.scripture.text}"</p></div>}
                              <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>💭 Real Talk</div><p style={{ fontSize: 13, color: C.text, margin: "6px 0", lineHeight: 1.8, whiteSpace: "pre-line" }}>{teenResult.real_talk}</p></div>
                              {teenResult.reflection?.length > 0 && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🤔 Reflect</div>{teenResult.reflection.map((q,i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "6px 0 0" }}>{i+1}. {q}</p>)}</div>}
                              {teenResult.prayer && <div style={{ ...cardS, background: `${C.purple}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🙏 Pray</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", fontStyle: "italic", lineHeight: 1.6 }}>{teenResult.prayer}</p></div>}
                              {teenResult.action && <div style={{ ...cardS, background: `${C.green}06`, borderLeft: `3px solid ${C.green}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>⚡ Do This Today</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0" }}>{teenResult.action}</p></div>}
                              {teenResult.playlist_vibe && <div style={{ ...cardS, padding: 10, textAlign: "center" }}><span style={{ fontSize: 10, color: C.dim }}>🎵 Worship vibe: {teenResult.playlist_vibe}</span></div>}
                            </>}

                            {/* CHALLENGE */}
                            {teenMode === "challenge" && <>
                              <div style={{ ...cardS, padding: 18, background: C.warm, textAlign: "center" }}><h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>🎯 {teenResult.title}</h3><p style={{ fontSize: 12, color: C.dim, margin: 0 }}>{teenResult.theme}</p>{teenResult.scripture && <p style={{ fontSize: 11, color: C.gold, margin: "6px 0 0", fontFamily: sans }}>📖 {teenResult.scripture}</p>}</div>
                              {teenResult.days?.map((d,i) => (
                                <div key={i} style={{ ...cardS, padding: 12, borderLeft: `3px solid ${i<3?C.green:i<5?C.blue:C.gold}` }}>
                                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${C.gold}12`, border: `1px solid ${C.gold}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: C.gold, flexShrink: 0, fontFamily: sans }}>{d.day}</div>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{d.title}</div>
                                      <p style={{ fontSize: 12, color: C.text, margin: "4px 0 2px", lineHeight: 1.5 }}>{d.task}</p>
                                      <p style={{ fontSize: 10, color: C.dim, margin: 0, fontStyle: "italic" }}>{d.why}</p>
                                      {d.share && <p style={{ fontSize: 9, color: C.blue, margin: "4px 0 0" }}>📱 {d.share}</p>}
                                    </div>
                                  </div>
                                </div>
                              ))}
                              {teenResult.reward && <div style={{ ...cardS, padding: 12, textAlign: "center", background: `${C.gold}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>🏆 Complete All 7</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0" }}>{teenResult.reward}</p></div>}
                            </>}

                            {/* DISCUSS */}
                            {teenMode === "discuss" && <>
                              <div style={{ ...cardS, padding: 18, background: C.warm }}><h3 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>💬 {teenResult.question}</h3><p style={{ fontSize: 12, color: C.dim, margin: 0, lineHeight: 1.5 }}>{teenResult.why_it_matters}</p></div>
                              {teenResult.what_world_says && <div style={{ ...cardS, borderLeft: `3px solid ${C.red}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.red }}>🌎 The World Says</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{teenResult.what_world_says}</p></div>}
                              {teenResult.what_scripture_says && <div style={{ ...cardS, borderLeft: `3px solid ${C.green}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>📖 Scripture Says</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{teenResult.what_scripture_says.teaching}</p>{teenResult.what_scripture_says.verses?.map((v,i) => <span key={i} style={{ display: "inline-block", fontSize: 10, color: C.gold, background: `${C.gold}08`, padding: "2px 8px", borderRadius: 4, marginRight: 4, marginTop: 2 }}>{v}</span>)}</div>}
                              {teenResult.discussion_prompts?.length > 0 && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🗣️ Discuss Together</div>{teenResult.discussion_prompts.map((q,i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "6px 0 0" }}>{i+1}. {q}</p>)}</div>}
                              {teenResult.for_mentors && <div style={{ ...cardS, background: `${C.blue}06`, borderLeft: `3px solid ${C.blue}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>🕊️ For Mentors</div><p style={{ fontSize: 11, color: C.text, margin: "4px 0", lineHeight: 1.5, fontStyle: "italic" }}>{teenResult.for_mentors}</p></div>}
                            </>}

                            {/* JOURNAL */}
                            {teenMode === "journal" && <>
                              <div style={{ ...cardS, padding: 16, background: C.warm, textAlign: "center" }}><h3 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>✍️ {teenResult.theme}</h3><p style={{ fontSize: 12, color: C.dim, margin: 0 }}>{teenResult.opening}</p></div>
                              {teenResult.prompts?.map((p,i) => <div key={i} style={{ ...cardS, padding: 14, borderLeft: `3px solid ${[C.purple,C.blue,C.green,C.gold,C.red][i%5]}` }}><p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "0 0 4px" }}>{p.prompt}</p><p style={{ fontSize: 11, color: C.dim, margin: "0 0 2px", fontStyle: "italic" }}>💡 {p.guide}</p><span style={{ fontSize: 10, color: C.gold }}>📖 {p.scripture}</span></div>)}
                              {teenResult.prayer_prompt && <div style={{ ...cardS, padding: 12, textAlign: "center", background: `${C.purple}06` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🙏 Finish This Prayer</div><p style={{ fontSize: 13, color: C.text, margin: "4px 0", fontStyle: "italic" }}>"{teenResult.prayer_prompt}"</p></div>}
                            </>}

                            {/* SERVE */}
                            {teenMode === "serve" && <>
                              <div style={{ ...cardS, padding: 16, background: C.warm, textAlign: "center" }}><h3 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: "0 0 4px", fontFamily: font }}>🤝 {teenResult.theme}</h3>{teenResult.scripture && <span style={{ fontSize: 11, color: C.gold }}>📖 {teenResult.scripture}</span>}</div>
                              {teenResult.projects?.map((p,i) => <div key={i} style={{ ...cardS, padding: 14 }}><div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{p.title}</div><p style={{ fontSize: 12, color: C.text, margin: "0 0 4px", lineHeight: 1.5 }}>{p.description}</p><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}><span style={{ fontSize: 9, color: C.blue }}>⏱️ {p.time}</span><span style={{ fontSize: 9, color: C.green }}>💚 {p.impact}</span></div><p style={{ fontSize: 10, color: C.gold, margin: "4px 0 0", fontStyle: "italic" }}>✝ {p.faith_lesson}</p>{p.mentor_role && <p style={{ fontSize: 9, color: C.purple, margin: "2px 0 0" }}>🕊️ Mentor: {p.mentor_role}</p>}</div>)}
                            </>}

                            {/* IDENTITY */}
                            {teenMode === "identity" && <>
                              <div style={{ ...cardS, padding: 18, background: C.warm, textAlign: "center" }}><h3 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: "0 0 6px", fontFamily: font }}>🪞 {teenResult.title}</h3></div>
                              {teenResult.lie && <div style={{ ...cardS, borderLeft: `3px solid ${C.red}`, padding: 14 }}><div style={{ fontSize: 11, fontWeight: 600, color: C.red }}>❌ The Lie</div><p style={{ fontSize: 14, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{teenResult.lie}</p></div>}
                              {teenResult.truth && <div style={{ ...cardS, borderLeft: `3px solid ${C.green}`, padding: 14 }}><div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>✅ The Truth</div><p style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{teenResult.truth}</p></div>}
                              {teenResult.scriptures?.map((s,i) => <div key={i} style={{ ...cardS, padding: 12 }}><span style={{ fontSize: 10, fontWeight: 600, color: C.gold }}>{s.ref}</span><p style={{ fontSize: 13, color: C.text, margin: "4px 0", fontFamily: font, fontStyle: "italic" }}>"{s.text}"</p><p style={{ fontSize: 11, color: C.blue, margin: 0 }}>→ {s.what_it_means}</p></div>)}
                              {teenResult.affirmation && <div style={{ ...cardS, padding: 14, textAlign: "center", background: `${C.gold}08`, borderColor: `${C.gold}25` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.gold }}>🌟 Say This</div><p style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "6px 0", fontFamily: font }}>{teenResult.affirmation}</p></div>}
                              {teenResult.mirror_exercise && <div style={cardS}><div style={{ fontSize: 11, fontWeight: 600, color: C.purple }}>🪞 Mirror Exercise</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{teenResult.mirror_exercise}</p></div>}
                              {teenResult.mentor_prompt && <div style={{ ...cardS, background: `${C.blue}06`, borderLeft: `3px solid ${C.blue}` }}><div style={{ fontSize: 11, fontWeight: 600, color: C.blue }}>🕊️ Ask Your Mentor</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", fontStyle: "italic" }}>{teenResult.mentor_prompt}</p></div>}
                            </>}

                            <button onClick={() => generateTeenContent(teenMode)} style={{ width: "100%", marginTop: 8, padding: 12, background: C.gold, border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>🔄 Generate New {TEEN_MODES.find(m=>m.id===teenMode)?.title}</button>
                            <AIDisclaimer type="teens" />
                          </div>
                        )}
                      </>
                    )}
                  </>}

                  {/* GAMES */}
                  {hubTab === "games" && <>
                    {/* Section header */}
                    <div style={{ textAlign: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🏃‍♂️</div>
                      <h3 style={{ fontSize: 17, fontWeight: 700, color: C.goldL, margin: "0 0 2px", fontFamily: font }}>Healthy Body, Healthy Mind</h3>
                      <p style={{ fontSize: 13, color: C.gold, margin: 0, fontStyle: "italic" }}>= Healthy Soul</p>
                      <p style={{ fontSize: 10, color: C.dim, margin: "4px 0 0" }}>Games, quizzes, and team challenges that strengthen faith</p>
                    </div>

                    {/* Game mode selector */}
                    <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                      {[
                        { id: "quiz", icon: "🧠", label: "Bible Quiz" },
                        { id: "generator", icon: "🎯", label: "Game Generator" },
                      ].map(m => (
                        <button key={m.id} onClick={() => { setGameMode(m.id); setGeneratedGame(null); }} style={{ flex: 1, padding: "8px 4px", background: gameMode===m.id ? `${C.gold}12` : C.card, border: `1px solid ${gameMode===m.id ? C.gold : C.border}`, borderRadius: 8, cursor: "pointer", textAlign: "center" }}>
                          <div style={{ fontSize: 18 }}>{m.icon}</div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: gameMode===m.id ? C.goldL : C.dim }}>{m.label}</div>
                        </button>
                      ))}
                    </div>

                    {/* BIBLE QUIZ MODE */}
                    {gameMode === "quiz" && <>
                      {!gameState.active ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{GAME_CATS.map(g => <button key={g.id} onClick={() => startQuiz(g.id)} style={{ ...cardS, cursor: "pointer", textAlign: "center", padding: 12 }}><div style={{ fontSize: 22, marginBottom: 3 }}>{g.icon}</div><div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{g.name}</div></button>)}</div>
                      : gameState.qIdx < (gameState.quizData?.questions?.length||0) ? <div style={cardS}><div style={{ width: "100%", height: 3, background: C.border, borderRadius: 2, marginBottom: 10 }}><div style={{ width: `${(gameState.qIdx/gameState.quizData.questions.length)*100}%`, height: "100%", background: C.gold, borderRadius: 2 }}/></div><p style={{ fontSize: 15, color: C.text, margin: "0 0 10px", fontWeight: 500 }}>{gameState.quizData.questions[gameState.qIdx].q}</p>{gameState.quizData.questions[gameState.qIdx].options.map((o,i) => <button key={i} onClick={() => answerQuiz(i)} style={{ width: "100%", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: font, marginBottom: 4 }}><span style={{ color: C.gold, fontFamily: mono, fontWeight: 700, marginRight: 6 }}>{String.fromCharCode(65+i)}</span>{o}</button>)}</div>
                      : <div style={{ textAlign: "center" }}><div style={{ fontSize: 40, marginBottom: 6 }}>{gameState.score>=6?"🏆":gameState.score>=4?"⭐":"📖"}</div><div style={{ fontSize: 28, fontWeight: 700, color: C.gold, fontFamily: mono }}>{gameState.score}/{gameState.quizData.questions.length}</div><button onClick={() => setGameState({active:null,score:0,qIdx:0,answers:[],quizData:null})} style={{ marginTop: 10, padding: 10, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: font, width: "100%" }}>🎮 Play Again</button></div>}
                      {isLoading("quiz") && <p style={{ textAlign: "center", color: C.dim }}>⏳ Generating quiz...</p>}
                    </>}

                    {/* GAME GENERATOR MODE */}
                    {gameMode === "generator" && <>
                      <div style={cardS}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.goldL, marginBottom: 8 }}>🎯 Custom Game Generator</div>

                        <div style={{ fontSize: 10, color: C.dim, fontWeight: 600, marginBottom: 4 }}>Age Group</div>
                        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                          {[{id:"kids",l:"Kids (4-12)",icon:"🌟"},{id:"teens",l:"Teens (13-18)",icon:"🔥"},{id:"adults",l:"Adults (18+)",icon:"👤"},{id:"mixed",l:"All Ages",icon:"👨‍👩‍👧‍👦"}].map(a => (
                            <button key={a.id} onClick={() => setGameConfig(g=>({...g,ageGroup:a.id}))} style={{ flex: 1, padding: "6px 2px", background: gameConfig.ageGroup===a.id?`${C.gold}12`:C.surface, border: `1px solid ${gameConfig.ageGroup===a.id?C.gold:C.border}`, borderRadius: 6, cursor: "pointer", textAlign: "center" }}>
                              <div style={{ fontSize: 14 }}>{a.icon}</div>
                              <div style={{ fontSize: 8, color: gameConfig.ageGroup===a.id?C.goldL:C.dim, fontWeight: 600 }}>{a.l}</div>
                            </button>
                          ))}
                        </div>

                        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: C.dim, fontWeight: 600, marginBottom: 4 }}>Group Size</div>
                            <select value={gameConfig.groupSize} onChange={e => setGameConfig(g=>({...g,groupSize:e.target.value}))} style={{ ...inputS, width: "100%", fontSize: 11, padding: "6px 8px" }}>
                              <option value="2-5">2-5 people</option>
                              <option value="5-10">5-10 people</option>
                              <option value="10-20">10-20 people</option>
                              <option value="20-50">20-50 people</option>
                              <option value="50+">50+ people</option>
                            </select>
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: C.dim, fontWeight: 600, marginBottom: 4 }}>Space</div>
                            <select value={gameConfig.space} onChange={e => setGameConfig(g=>({...g,space:e.target.value}))} style={{ ...inputS, width: "100%", fontSize: 11, padding: "6px 8px" }}>
                              <option value="indoor">Indoor (small room)</option>
                              <option value="indoor-large">Indoor (hall/gym)</option>
                              <option value="outdoor">Outdoor (field)</option>
                              <option value="anywhere">Anywhere</option>
                            </select>
                          </div>
                        </div>

                        <div style={{ fontSize: 10, color: C.dim, fontWeight: 600, marginBottom: 4 }}>Sermon Topic (optional)</div>
                        <input value={gameConfig.topic} onChange={e => setGameConfig(g=>({...g,topic:e.target.value}))} placeholder="e.g. faith, teamwork, trust in God, Romans 8:28..." maxLength={200} style={{ ...inputS, fontSize: 11, marginBottom: 10 }} />

                        <div style={{ fontSize: 10, color: C.dim, fontWeight: 600, marginBottom: 6 }}>Generate a...</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          {[
                            { type: "team building", icon: "🤝", label: "Team Builder", desc: "Collaboration & trust" },
                            { type: "icebreaker", icon: "🧊", label: "Icebreaker", desc: "Quick 5-min opener" },
                            { type: "youth group game", icon: "🎮", label: "Youth Group", desc: "Active & energetic" },
                            { type: "relay race", icon: "🏃", label: "Relay Race", desc: "Competitive teams" },
                            { type: "scavenger hunt", icon: "🔍", label: "Scavenger Hunt", desc: "Explore & discover" },
                            { type: "minute-to-win-it challenge", icon: "⏱️", label: "Minute to Win It", desc: "Quick challenges" },
                            { type: "escape room puzzle", icon: "🔐", label: "Escape Room", desc: "Solve puzzles together" },
                            { type: "worship game", icon: "🎵", label: "Worship Game", desc: "Music & praise" },
                          ].map(g => (
                            <button key={g.type} onClick={() => generateGame(g.type)} disabled={isLoading("gameGen")} style={{ ...cardS, cursor: isLoading("gameGen") ? "default" : "pointer", textAlign: "center", padding: 10 }}>
                              <div style={{ fontSize: 20, marginBottom: 2 }}>{g.icon}</div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{g.label}</div>
                              <div style={{ fontSize: 8, color: C.dim }}>{g.desc}</div>
                            </button>
                          ))}
                        </div>
                        {isLoading("gameGen") && <p style={{ textAlign: "center", color: C.dim, marginTop: 8 }}>⏳ Creating your game...</p>}
                      </div>

                      {/* Generated game display */}
                      {generatedGame && (
                        <div style={{ ...cardS, marginTop: 10, borderLeft: `3px solid ${C.gold}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <div>
                              <div style={{ fontSize: 16, fontWeight: 700, color: C.goldL }}>{generatedGame.emoji} {generatedGame.name}</div>
                              <div style={{ fontSize: 10, color: C.dim }}>{generatedGame.type} • {generatedGame.duration} • {generatedGame.energy_level} energy</div>
                            </div>
                            <button onClick={() => { navigator.clipboard?.writeText(JSON.stringify(generatedGame, null, 2)); showToast("📋 Game copied!"); }} style={{ background: C.gold, border: "none", color: "#fff", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Copy</button>
                          </div>

                          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                            <span style={{ ...tagS(C.blue), fontSize: 9 }}>👥 {generatedGame.group_size}</span>
                            <span style={{ ...tagS(C.green), fontSize: 9 }}>📍 {generatedGame.space}</span>
                            <span style={{ ...tagS(C.purple), fontSize: 9 }}>🎂 {generatedGame.age_group}</span>
                          </div>

                          {generatedGame.scripture_tie && (
                            <div style={{ background: `${C.gold}08`, borderRadius: 8, padding: 8, marginBottom: 8 }}>
                              <span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>SCRIPTURE CONNECTION</span>
                              <p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{generatedGame.scripture_tie}</p>
                            </div>
                          )}

                          <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginBottom: 4 }}>MATERIALS</div>
                          <p style={{ fontSize: 12, color: C.text, margin: "0 0 8px" }}>{(generatedGame.materials || []).join(", ") || "None needed"}</p>

                          <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginBottom: 4 }}>SETUP</div>
                          <p style={{ fontSize: 12, color: C.text, margin: "0 0 8px", lineHeight: 1.5 }}>{generatedGame.setup}</p>

                          <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginBottom: 4 }}>RULES</div>
                          {(generatedGame.rules || []).map((r, i) => (
                            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "flex-start" }}>
                              <span style={{ fontSize: 10, color: C.gold, fontWeight: 700, fontFamily: mono, minWidth: 16 }}>{i+1}.</span>
                              <span style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{r}</span>
                            </div>
                          ))}

                          {generatedGame.variations?.length > 0 && <>
                            <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginTop: 8, marginBottom: 4 }}>VARIATIONS</div>
                            {generatedGame.variations.map((v, i) => <p key={i} style={{ fontSize: 11, color: C.dim, margin: "0 0 3px" }}>• {v}</p>)}
                          </>}

                          <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginTop: 8, marginBottom: 4 }}>DEBRIEF QUESTIONS</div>
                          {(generatedGame.debrief || []).map((q, i) => <p key={i} style={{ fontSize: 12, color: C.text, margin: "0 0 4px" }}>💬 {q}</p>)}

                          {generatedGame.leader_tip && (
                            <div style={{ background: `${C.green}08`, borderRadius: 8, padding: 8, marginTop: 8 }}>
                              <span style={{ fontSize: 9, color: C.green, fontWeight: 700, fontFamily: mono }}>💡 LEADER TIP</span>
                              <p style={{ fontSize: 11, color: C.text, margin: "2px 0 0" }}>{generatedGame.leader_tip}</p>
                            </div>
                          )}

                          <button onClick={() => generateGame(generatedGame.type)} disabled={isLoading("gameGen")} style={{ width: "100%", marginTop: 10, padding: 10, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 8, color: C.gold, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>🎲 Generate Another {generatedGame.type}</button>
                          <AIDisclaimer type="games" />
                        </div>
                      )}
                    </>}
                  </>}

                  {/* EVENTS */}
                  {hubTab === "events" && <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><h3 style={{ fontSize: 14, fontWeight: 600, color: C.goldL, margin: 0 }}>📅 Events</h3><button onClick={() => setShowEventForm(!showEventForm)} style={{ background: `${C.gold}12`, border: `1px solid ${C.gold}25`, color: C.gold, padding: "4px 10px", borderRadius: 6, fontSize: 10, cursor: "pointer", fontFamily: mono }}>{showEventForm?"✕":"+ Post"}</button></div>
                    {showEventForm && <div style={{ ...cardS, padding: 12, marginBottom: 8 }}><input value={eventForm.title} onChange={e => setEventForm(f=>({...f,title:e.target.value}))} placeholder="Event name" maxLength={200} style={{ ...inputS, marginBottom: 5, fontSize: 13 }} /><div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 5 }}>{EVENT_TYPES.map(t => <button key={t.id} onClick={() => setEventForm(f=>({...f,type:t.id}))} style={{ background: eventForm.type===t.id?`${t.color}18`:C.surface, border: `1px solid ${eventForm.type===t.id?`${t.color}35`:C.border}`, color: eventForm.type===t.id?t.color:C.dim, borderRadius: 12, padding: "3px 8px", fontSize: 9, cursor: "pointer" }}>{t.label}</button>)}</div><button onClick={postEvent} disabled={!eventForm.title||!eventForm.type} style={{ width: "100%", padding: 8, background: eventForm.title&&eventForm.type?`linear-gradient(135deg, ${C.gold}, #a0832e)`:C.card, border: "none", borderRadius: 6, color: eventForm.title&&eventForm.type?"#fff":C.dim, fontSize: 12, fontWeight: 700, cursor: eventForm.title&&eventForm.type?"pointer":"default" }}>📅 Post</button></div>}
                    {events.length===0 ? <p style={{ textAlign: "center", color: C.dim, fontSize: 12 }}>No events yet.</p> : events.map(ev => {const et=EVENT_TYPES.find(t=>t.id===ev.type);return <div key={ev.id} style={{ ...cardS, borderLeft: `3px solid ${et?.color||C.gold}` }}><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{ev.title}</div><div style={{ fontSize: 10, color: et?.color||C.dim }}>{et?.label||ev.type} • {ev.date}</div>{ev.desc && <p style={{ fontSize: 11, color: C.dim, margin: "4px 0" }}>{ev.desc}</p>}<div style={{ display: "flex", gap: 4 }}>{[{t:"going",i:"✋"},{t:"interested",i:"⭐"},{t:"praying",i:"🙏"}].map(r => <button key={r.t} onClick={() => reactEvent(ev.id,r.t)} style={{ flex: 1, padding: "3px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer", textAlign: "center", fontSize: 10, color: C.dim }}>{r.i} {ev.reactions?.[r.t]||0}</button>)}</div></div>})}
                  </>}

                  {/* CHARITY */}
                  {hubTab === "charity" && CHARITY_CAUSES.map(c => {const pct=Math.round((Math.random()*c.goal*0.7)/c.goal*100);return <div key={c.id} style={cardS}><div style={{ display: "flex", gap: 8 }}><div style={{ fontSize: 24, flexShrink: 0 }}>{c.icon}</div><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{c.name}</div><p style={{ fontSize: 11, color: C.dim, margin: "2px 0 6px" }}>{c.desc}</p><div style={{ width: "100%", height: 6, background: C.border, borderRadius: 3 }}><div style={{ width: `${pct}%`, height: "100%", background: c.color, borderRadius: 3 }}/></div><div style={{ fontSize: 9, color: C.dim, fontFamily: mono, marginTop: 2 }}>{pct}% of ${c.goal} goal</div></div></div></div>})}

                  {/* MENTORSHIP */}
                  {hubTab === "mentorship" && MENTOR_ROLES.map(r => <div key={r.id} style={{ ...cardS, display: "flex", gap: 8, alignItems: "center" }}><div style={{ fontSize: 24 }}>{r.icon}</div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{r.title}</div></div>)}

                  {/* FAMILY */}
                  {hubTab === "family" && <>
                    <button onClick={generateFamily} disabled={isLoading("family")} style={{ width: "100%", padding: 12, background: isLoading("family")?C.card:`linear-gradient(135deg, ${C.blue}, #3366cc)`, border: "none", borderRadius: 8, color: isLoading("family")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("family")?"default":"pointer", fontFamily: font, marginBottom: 10 }}>{isLoading("family")?"⏳ Generating...":"🎲 Generate Family Activity Pack"}</button>
                    {familyActivities && <div>{familyActivities.memory_verse && <div style={{ ...cardS, textAlign: "center", background: `${C.gold}06` }}><div style={{ fontSize: 14, fontWeight: 700, color: C.goldL }}>{familyActivities.theme}</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0 0", fontStyle: "italic" }}>"{familyActivities.memory_verse.text}" — {familyActivities.memory_verse.ref}</p></div>}{familyActivities.activities?.map((a,i) => {const icons={game:"🎮",craft:"✂️",devotion:"📖",service:"🤝",cooking:"🍳",outdoor:"🌳"};return <div key={i} style={cardS}><div style={{ display: "flex", gap: 6 }}><div style={{ fontSize: 20 }}>{icons[a.type]||"⭐"}</div><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{a.title}</div><div style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{a.type} • {a.ages} • {a.duration}</div><p style={{ fontSize: 12, color: C.text, margin: "4px 0", lineHeight: 1.5 }}>{a.description}</p><p style={{ fontSize: 10, color: C.gold, margin: 0, fontStyle: "italic" }}>✝ {a.faith_connection}</p></div></div></div>})}<AIDisclaimer type="family" /></div>}
                  </>}

                  {/* HEALTHY SOUL — Biblical Health & Nutrition */}
                  {hubTab === "wellness" && <>
                    <div style={{ textAlign: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 28, marginBottom: 4 }}>🌿</div>
                      <h3 style={{ fontSize: 17, fontWeight: 700, color: C.green, margin: "0 0 2px", fontFamily: font }}>Healthy Soul</h3>
                      <p style={{ fontSize: 12, color: C.dim, margin: 0, fontStyle: "italic" }}>Healthy Body, Healthy Mind = Healthy Soul</p>
                      <p style={{ fontSize: 10, color: C.dim, margin: "2px 0 0" }}>"Do you not know that your body is a temple?" — 1 Cor 6:19</p>
                    </div>

                    {/* Mode selector */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                      {WELLNESS_MODES.map(m => (
                        <button key={m.id} onClick={() => { setWellnessMode(m.id); setWellnessResult(null); setWellnessQuery(""); }} style={{ padding: "10px 4px", background: wellnessMode===m.id ? `${m.color}12` : C.card, border: `1px solid ${wellnessMode===m.id ? m.color : C.border}`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                          <div style={{ fontSize: 20, marginBottom: 2 }}>{m.icon}</div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: wellnessMode===m.id ? m.color : C.text }}>{m.title}</div>
                        </button>
                      ))}
                    </div>

                    {/* Query input for modes that need it */}
                    {wellnessMode && (
                      <div style={{ marginBottom: 10 }}>
                        {/* Per-mode preset chips */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                          {(wellnessMode === "biblical-foods" ? ["Olive Oil","Honey","Figs","Pomegranate","Lentils","Wine","Bread","Fish","Dates","Grapes"]
                          : wellnessMode === "daniel-fast" ? ["Spiritual renewal","Healing","Clarity","Breakthrough","Discipline","Surrender"]
                          : wellnessMode === "healing-foods" ? ["Stress","Fatigue","Inflammation","Sleep","Digestion","Immunity","Heart health","Joint pain"]
                          : wellnessMode === "biblical-recipe" ? ["Breakfast","Lunch","Dinner","Soup","Bread","Dessert","Vegetarian","Feast"]
                          : wellnessMode === "body-temple" ? ["Sleep","Exercise","Nutrition","Rest","Mental health","Addiction","Body image","Aging"]
                          : ["Healing","Peace","Strength","Rest","Anxiety","Depression","Grief","Gratitude"]
                          ).map(s => (
                            <button key={s} onClick={() => setWellnessQuery(s)} style={{ padding: "3px 8px", background: wellnessQuery===s?`${C.green}15`:C.surface, border: `1px solid ${wellnessQuery===s?C.green:C.border}`, borderRadius: 12, fontSize: 9, color: wellnessQuery===s?C.green:C.dim, cursor: "pointer" }}>{s}</button>
                          ))}
                        </div>
                        <input value={wellnessQuery} onChange={e => setWellnessQuery(e.target.value)} placeholder="Or type your own..." maxLength={200} style={{ ...inputS, fontSize: 11, marginBottom: 6 }} />
                        <button onClick={() => generateWellness(wellnessMode, wellnessQuery)} disabled={isLoading("wellness")} style={{ width: "100%", padding: 12, background: isLoading("wellness") ? C.card : `linear-gradient(135deg, ${C.green}, #2d6b3f)`, border: "none", borderRadius: 8, color: isLoading("wellness") ? C.dim : "#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("wellness") ? "default" : "pointer" }}>
                          {isLoading("wellness") ? "⏳ Preparing..." : `🌿 Generate ${WELLNESS_MODES.find(m=>m.id===wellnessMode)?.title}`}
                        </button>
                      </div>
                    )}

                    {/* Results display */}
                    {wellnessResult && wellnessMode === "biblical-foods" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.green}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.green, marginBottom: 4 }}>{wellnessResult.emoji} {wellnessResult.food}</div>
                        {wellnessResult.hebrew_name && <div style={{ fontSize: 11, color: C.purple, fontFamily: mono }}>{wellnessResult.hebrew_name} — "{wellnessResult.meaning}"</div>}
                        {wellnessResult.bible_references?.map((r,i) => <div key={i} style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginTop: 6 }}><span style={{ fontSize: 10, color: C.gold, fontWeight: 700 }}>{r.ref}</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>{r.context}</p><p style={{ fontSize: 10, color: C.dim, margin: "2px 0 0", fontStyle: "italic" }}>{r.significance}</p></div>)}
                        {wellnessResult.nutritional_profile && <div style={{ marginTop: 8 }}><div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono }}>NUTRITION</div><p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>🥗 {wellnessResult.nutritional_profile.health_benefits?.join(" • ")}</p></div>}
                        {wellnessResult.spiritual_symbolism && <p style={{ fontSize: 12, color: C.gold, marginTop: 6, fontStyle: "italic" }}>✝ {wellnessResult.spiritual_symbolism}</p>}
                        {wellnessResult.prayer && <div style={{ background: `${C.purple}06`, borderRadius: 6, padding: 8, marginTop: 6 }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>PRAYER</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{wellnessResult.prayer}</p></div>}
                        <AddBtn label={`Biblical Food: ${wellnessResult.food}`} content={`${wellnessResult.food}: ${wellnessResult.spiritual_symbolism}\n${wellnessResult.bible_references?.map(r=>r.ref+': '+r.context).join('\n')}`} />
                      </div>
                    )}

                    {wellnessResult && wellnessMode === "daniel-fast" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.blue}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.blue, marginBottom: 2 }}>🍃 {wellnessResult.fast_name}</div>
                        <div style={{ fontSize: 10, color: C.dim }}>{wellnessResult.duration} • {wellnessResult.scripture_basis}</div>
                        <p style={{ fontSize: 12, color: C.text, margin: "6px 0", lineHeight: 1.5 }}>{wellnessResult.purpose}</p>
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1 }}><div style={{ fontSize: 9, color: C.green, fontWeight: 700, fontFamily: mono }}>EAT</div>{wellnessResult.what_to_eat?.map((f,i) => <p key={i} style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>✅ {f}</p>)}</div>
                          <div style={{ flex: 1 }}><div style={{ fontSize: 9, color: C.red, fontWeight: 700, fontFamily: mono }}>AVOID</div>{wellnessResult.what_to_avoid?.map((f,i) => <p key={i} style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>❌ {f}</p>)}</div>
                        </div>
                        {wellnessResult.daily_plan?.map((d,i) => <div key={i} style={{ background: C.surface, borderRadius: 8, padding: 8, marginBottom: 6 }}><div style={{ fontSize: 12, fontWeight: 700, color: C.blue }}>{d.day}: {d.theme}</div><div style={{ fontSize: 10, color: C.gold }}>{d.scripture}</div><p style={{ fontSize: 10, color: C.text, margin: "2px 0" }}>🍽️ {d.meal_ideas}</p><p style={{ fontSize: 10, color: C.purple, margin: "2px 0", fontStyle: "italic" }}>🙏 {d.prayer_focus}</p></div>)}
                        <AddBtn label="Daniel Fast Plan" content={`${wellnessResult.fast_name} — ${wellnessResult.duration}\n${wellnessResult.scripture_basis}\n\n${wellnessResult.daily_plan?.map(d=>d.day+': '+d.theme+' ('+d.scripture+')').join('\n')}`} />
                      </div>
                    )}

                    {wellnessResult && wellnessMode === "healing-foods" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.gold}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.gold, marginBottom: 2 }}>🌿 Healing Foods for: {wellnessResult.concern}</div>
                        {wellnessResult.scripture_comfort && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginBottom: 8 }}><p style={{ fontSize: 12, color: C.text, fontStyle: "italic", margin: 0 }}>{wellnessResult.scripture_comfort}</p></div>}
                        {wellnessResult.biblical_foods?.map((f,i) => <div key={i} style={{ background: C.surface, borderRadius: 8, padding: 8, marginBottom: 6 }}><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.emoji} {f.food}</div><div style={{ fontSize: 10, color: C.gold }}>{f.scripture}</div><p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>{f.how_it_helps}</p></div>)}
                        {wellnessResult.daily_routine && <div style={{ marginTop: 6 }}><div style={{ fontSize: 9, color: C.dim, fontWeight: 700, fontFamily: mono }}>DAILY ROUTINE</div><p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>🌅 AM: {wellnessResult.daily_routine.morning}</p><p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>☀️ PM: {wellnessResult.daily_routine.afternoon}</p><p style={{ fontSize: 11, color: C.text, margin: "2px 0" }}>🌙 Eve: {wellnessResult.daily_routine.evening}</p></div>}
                        {wellnessResult.prayer && <div style={{ background: `${C.purple}06`, borderRadius: 6, padding: 8, marginTop: 8 }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>HEALING PRAYER</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{wellnessResult.prayer}</p></div>}
                        {wellnessResult.disclaimer && <p style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>⚠ {wellnessResult.disclaimer}</p>}
                      </div>
                    )}

                    {wellnessResult && wellnessMode === "biblical-recipe" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.red}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.red, marginBottom: 2 }}>{wellnessResult.emoji} {wellnessResult.recipe_name}</div>
                        <p style={{ fontSize: 11, color: C.dim }}>{wellnessResult.description} • Serves {wellnessResult.servings} • {wellnessResult.prep_time} prep + {wellnessResult.cook_time} cook</p>
                        <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginTop: 8 }}>BIBLICAL INGREDIENTS</div>
                        {wellnessResult.biblical_ingredients?.map((ing,i) => <div key={i} style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "flex-start" }}><span style={{ fontSize: 11, color: C.text, flex: 1 }}>{ing.ingredient}</span><span style={{ fontSize: 9, color: C.gold, fontStyle: "italic", flex: 1 }}>{ing.scripture}</span></div>)}
                        <div style={{ fontSize: 10, color: C.dim, fontWeight: 700, fontFamily: mono, marginTop: 8 }}>INSTRUCTIONS</div>
                        {wellnessResult.instructions?.map((s,i) => <div key={i} style={{ display: "flex", gap: 6, marginTop: 4 }}><span style={{ fontSize: 10, color: C.gold, fontWeight: 700, fontFamily: mono, minWidth: 16 }}>{i+1}.</span><span style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{s}</span></div>)}
                        {wellnessResult.table_blessing && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginTop: 8 }}><span style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono }}>TABLE BLESSING</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{wellnessResult.table_blessing}</p></div>}
                      </div>
                    )}

                    {wellnessResult && wellnessMode === "body-temple" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.purple}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.purple, marginBottom: 2 }}>🏛️ {wellnessResult.title}</div>
                        {wellnessResult.key_verse && <div style={{ background: `${C.gold}06`, borderRadius: 6, padding: 8, marginBottom: 8 }}><p style={{ fontSize: 13, color: C.text, fontStyle: "italic", margin: 0 }}>"{wellnessResult.key_verse.text}"</p><span style={{ fontSize: 10, color: C.gold }}>— {wellnessResult.key_verse.ref}</span></div>}
                        <p style={{ fontSize: 13, color: C.text, margin: "0 0 8px", lineHeight: 1.8, whiteSpace: "pre-line" }}>{wellnessResult.reflection}</p>
                        {wellnessResult.body_check && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>{[{k:"physical",icon:"💪",color:C.green},{k:"mental",icon:"🧠",color:C.blue},{k:"spiritual",icon:"✝",color:C.gold}].map(c => <div key={c.k} style={{ flex: 1, background: `${c.color}06`, borderRadius: 8, padding: 8, textAlign: "center" }}><div style={{ fontSize: 16 }}>{c.icon}</div><div style={{ fontSize: 9, color: c.color, fontWeight: 700 }}>{c.k.toUpperCase()}</div><p style={{ fontSize: 10, color: C.text, margin: "2px 0 0" }}>{wellnessResult.body_check[c.k]}</p></div>)}</div>}
                        {wellnessResult.practical_challenge && <div style={{ background: C.surface, borderRadius: 8, padding: 8, marginBottom: 6 }}><span style={{ fontSize: 9, color: C.green, fontWeight: 700, fontFamily: mono }}>THIS WEEK'S CHALLENGE</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>{wellnessResult.practical_challenge}</p></div>}
                        {wellnessResult.prayer && <div style={{ background: `${C.purple}06`, borderRadius: 6, padding: 8 }}><span style={{ fontSize: 9, color: C.purple, fontWeight: 700, fontFamily: mono }}>PRAYER</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0", fontStyle: "italic" }}>{wellnessResult.prayer}</p></div>}
                        <AddBtn label="Body Temple Devotional" content={`${wellnessResult.title}\n${wellnessResult.key_verse?.ref}: ${wellnessResult.key_verse?.text}\n\n${wellnessResult.reflection}`} />
                      </div>
                    )}

                    {wellnessResult && wellnessMode === "wellness-prayer" && (
                      <div style={{ ...cardS, borderLeft: `3px solid ${C.miracle}` }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.miracle, marginBottom: 4 }}>🙏 {wellnessResult.title}</div>
                        {wellnessResult.opening && <div style={{ marginBottom: 8 }}><p style={{ fontSize: 13, color: C.text, margin: 0, fontStyle: "italic", lineHeight: 1.7 }}>{wellnessResult.opening.text}</p><p style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>🧘 Posture: {wellnessResult.opening.posture}</p></div>}
                        {[{k:"body_scan",icon:"🫀",title:"Body"},{k:"mind_clearing",icon:"🧠",title:"Mind"},{k:"spirit_filling",icon:"🕊️",title:"Spirit"}].map(s => wellnessResult[s.k] && <div key={s.k} style={{ background: C.surface, borderRadius: 8, padding: 8, marginBottom: 6 }}><div style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{s.icon} {s.title}</div><p style={{ fontSize: 11, color: C.dim, margin: "2px 0" }}>{wellnessResult[s.k].instruction}</p><p style={{ fontSize: 12, color: C.text, margin: "2px 0", fontStyle: "italic" }}>{wellnessResult[s.k].prayer}</p></div>)}
                        {wellnessResult.scripture_declarations?.length > 0 && <div style={{ marginTop: 6 }}><div style={{ fontSize: 9, color: C.gold, fontWeight: 700, fontFamily: mono, marginBottom: 4 }}>SCRIPTURE DECLARATIONS</div>{wellnessResult.scripture_declarations.map((d,i) => <div key={i} style={{ background: `${C.gold}06`, borderRadius: 6, padding: 6, marginBottom: 3 }}><span style={{ fontSize: 10, color: C.gold }}>{d.verse}:</span> <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{d.declaration}</span></div>)}</div>}
                        {wellnessResult.closing && <p style={{ fontSize: 12, color: C.text, margin: "8px 0", fontStyle: "italic", lineHeight: 1.6 }}>{wellnessResult.closing}</p>}
                        {wellnessResult.wellness_action && <div style={{ background: `${C.green}06`, borderRadius: 6, padding: 8, marginTop: 4 }}><span style={{ fontSize: 9, color: C.green, fontWeight: 700, fontFamily: mono }}>WELLNESS ACTION</span><p style={{ fontSize: 12, color: C.text, margin: "2px 0 0" }}>🌿 {wellnessResult.wellness_action}</p></div>}
                        <AddBtn label="Wellness Prayer" content={`${wellnessResult.title}\n\n${wellnessResult.opening?.text}\n\n${wellnessResult.scripture_declarations?.map(d=>d.verse+': '+d.declaration).join('\n')}\n\n${wellnessResult.closing}`} />
                      </div>
                    )}

                    {isLoading("wellness") && <div style={{ textAlign: "center", padding: "30px 0" }}><div style={{ fontSize: 32, marginBottom: 8, animation: "float 1.5s ease infinite" }}>🌿</div><p style={{ color: C.dim, fontSize: 13 }}>Preparing something nourishing...</p></div>}
                    <AIDisclaimer type="wellness" />
                  </>}

                  <button onClick={loadSermons} style={{ width: "100%", padding: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.dim, fontSize: 10, cursor: "pointer", fontFamily: font, marginTop: 8 }}>🔄 Refresh</button>
                </>
              )}

              {/* COMPOSE */}
              {shareMode === "compose" && <div>
                <button onClick={() => setShareMode(null)} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer", padding: "0 0 8px", fontFamily: font }}>← Back</button>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: C.goldL, margin: "0 0 10px" }}>✍️ Share Sermon</h3>
                <input value={shareForm.author} onChange={e => setShareForm(f=>({...f,author:e.target.value}))} placeholder="Your name" maxLength={100} style={{ ...inputS, marginBottom: 6, fontSize: 13 }} />
                <input value={shareForm.title} onChange={e => setShareForm(f=>({...f,title:e.target.value}))} placeholder="Sermon title *" maxLength={200} style={{ ...inputS, marginBottom: 6, fontSize: 13 }} />
                <input value={shareForm.passage} onChange={e => setShareForm(f=>({...f,passage:e.target.value}))} placeholder="Passage" maxLength={100} style={{ ...inputS, marginBottom: 6, fontSize: 13 }} />
                <textarea value={shareForm.body} onChange={e => setShareForm(f=>({...f,body:e.target.value}))} placeholder="Share the Word..." maxLength={INPUT_LIMITS.sermonBody} style={{ ...inputS, minHeight: 120, fontSize: 13, resize: "vertical", lineHeight: 1.7 }} />
                <button onClick={publishSermon} disabled={!shareForm.title||!shareForm.body} style={{ width: "100%", marginTop: 8, padding: 12, background: shareForm.title&&shareForm.body?`linear-gradient(135deg, ${C.gold}, #a0832e)`:C.card, border: "none", borderRadius: 8, color: shareForm.title&&shareForm.body?"#fff":C.dim, fontSize: 14, fontWeight: 700, cursor: shareForm.title&&shareForm.body?"pointer":"default", fontFamily: font }}>🕊️ Publish</button>
              </div>}

              {/* VIEW */}
              {shareMode === "view" && viewSermon && <div>
                <button onClick={() => { setShareMode(null); setViewSermon(null); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer", padding: "0 0 8px", fontFamily: font }}>← Back</button>
                <div style={{ borderLeft: `3px solid ${C.gold}`, paddingLeft: 10, marginBottom: 10 }}><h2 style={{ fontSize: 17, fontWeight: 700, color: C.goldL, margin: "0 0 2px" }}>{viewSermon.title}</h2><div style={{ fontSize: 10, color: C.dim }}>by {viewSermon.author} • {viewSermon.displayDate}</div></div>
                <div style={{ ...cardS, padding: 14 }}><p style={{ fontSize: 14, color: C.text, margin: 0, lineHeight: 1.8, whiteSpace: "pre-line" }}>{viewSermon.body}</p></div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  {[{t:"love",i:"❤️",c:"#f87171"},{t:"pray",i:"🙏",c:"#a78bfa"},{t:"amen",i:"🙌",c:C.gold}].map(r => <button key={r.t} onClick={() => reactToSermon(viewSermon.id,r.t)} aria-label={r.t} style={{ flex: 1, padding: "7px 4px", background: `${r.c}08`, border: `1px solid ${r.c}25`, borderRadius: 8, cursor: "pointer", textAlign: "center" }}><div style={{ fontSize: 16 }}>{r.i}</div><div style={{ fontSize: 14, fontWeight: 700, color: r.c, fontFamily: mono }}>{viewSermon.reactions?.[r.t]||0}</div></button>)}
                </div>
                <button onClick={() => addToDoc("sermon-shared",viewSermon.title,`${viewSermon.title} — ${viewSermon.author}\n\n${viewSermon.body}`)} style={{ width: "100%", padding: 7, background: `${C.green}10`, border: `1px solid ${C.green}25`, borderRadius: 6, color: C.green, fontSize: 10, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>📄 Save to Doc</button>
                <div style={{ fontSize: 9, color: C.dim, fontFamily: mono, marginBottom: 4 }}>COMMENTS ({viewSermon.comments?.length||0})</div>
                {(viewSermon.comments||[]).map(c => <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: 7, marginBottom: 3 }}><span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{c.author}</span><p style={{ fontSize: 11, color: C.text, margin: "2px 0 0" }}>{c.text}</p></div>)}
                <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                  <input value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="Encourage..." maxLength={INPUT_LIMITS.comment} style={{ ...inputS, flex: 1, fontSize: 11 }} onKeyDown={e => { if(e.key==="Enter") addComment(viewSermon.id); }} />
                  <button onClick={() => addComment(viewSermon.id)} disabled={!commentText.trim()} style={{ background: commentText.trim()?`${C.gold}15`:C.surface, border: `1px solid ${commentText.trim()?`${C.gold}30`:C.border}`, color: commentText.trim()?C.gold:C.dim, borderRadius: 5, padding: "0 10px", fontSize: 11, cursor: commentText.trim()?"pointer":"default" }}>Send</button>
                </div>
              </div>}
            </div>
          )}
        </main>
      )}

      {/* ═══ PODIUM (F10+F13) ═══ */}
      {screen === "podium" && podiumSections.length > 0 && (
        <div style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: "20px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <button onClick={() => setScreen("results")} aria-label="Exit podium" style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: mono }}>✕ Exit</button>
            <span style={{ fontSize: 10, color: C.gold, fontFamily: mono }}>{podiumSections[podiumSection]?.label}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPodiumFontSize(s => Math.max(16, s-2))} aria-label="Decrease font" style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}>A-</button>
              <button onClick={() => setPodiumFontSize(s => Math.min(48, s+2))} aria-label="Increase font" style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}>A+</button>
            </div>
          </div>
          {/* F13: Tap zones — left 30% = back, right 70% = forward */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            <div onClick={() => setPodiumSection(s => Math.max(0, s-1))} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "30%", cursor: "pointer", zIndex: 10 }} aria-label="Previous section" />
            <div onClick={() => setPodiumSection(s => Math.min(podiumSections.length-1, s+1))} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "70%", cursor: "pointer", zIndex: 10 }} aria-label="Next section" />
            <p style={{ fontSize: podiumFontSize, lineHeight: 1.6, textAlign: "center", whiteSpace: "pre-line", maxWidth: "90%", fontFamily: font }}>
              {podiumSections[podiumSection]?.text || ""}
            </p>
          </div>
          <div style={{ textAlign: "center", paddingBottom: 20 }}>
            {/* F13: Visual nav dots */}
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 6 }}>
              {podiumSections.map((_,i) => <div key={i} onClick={() => setPodiumSection(i)} style={{ width: i===podiumSection?12:8, height: 8, borderRadius: 4, background: i===podiumSection?C.gold:"rgba(255,255,255,0.2)", cursor: "pointer", transition: "all 0.2s" }} />)}
            </div>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: mono }}>← Left tap: back | Right tap: forward → {podiumSection+1}/{podiumSections.length}</span>
          </div>
        </div>
      )}

      {/* ═══ DAILY BRIEFING MODAL ═══ */}
      {showBriefing && briefing && (
        <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 250, overflow: "auto", padding: "0 16px 80px" }}>
          <div style={{ maxWidth: 600, margin: "0 auto" }}>
            {/* Header */}
            <div style={{ position: "sticky", top: 0, background: C.bg, padding: "12px 0 8px", zIndex: 10, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: C.goldL, margin: 0 }}>📰 Daily Faith Briefing</h2>
                <p style={{ fontSize: 9, color: C.dim, fontFamily: mono, margin: "2px 0 0" }}>{briefing.date || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={generateBriefing} disabled={isLoading("briefing")} style={{ background: `${C.blue}10`, border: `1px solid ${C.blue}25`, color: C.blue, padding: "4px 8px", borderRadius: 6, fontSize: 9, cursor: "pointer", fontFamily: mono }}>{isLoading("briefing")?"⏳":"🔄"}</button>
                <button onClick={() => setShowBriefing(false)} style={{ background: `${C.red}08`, border: `1px solid ${C.red}20`, color: C.red, padding: "4px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer" }}>✕</button>
              </div>
            </div>

            {/* ✨ INSPIRING STORY — Always First */}
            {briefing.inspiring && (
              <div style={{ background: `linear-gradient(135deg, ${C.miracle}08, ${C.gold}06)`, border: `1px solid ${C.miracle}25`, borderRadius: 14, padding: 16, marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 20 }}>✨</span>
                  <span style={{ fontSize: 9, fontFamily: mono, color: C.miracle, textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>Inspiring Story</span>
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: "0 0 6px", lineHeight: 1.3 }}>{briefing.inspiring.headline}</h3>
                <p style={{ fontSize: 13, color: C.text, margin: "0 0 8px", lineHeight: 1.7 }}>{briefing.inspiring.summary}</p>
                {briefing.inspiring.source && <p style={{ fontSize: 9, color: C.dim, fontFamily: mono, margin: "0 0 8px" }}>— {briefing.inspiring.source}</p>}
                <div style={{ background: `${C.miracle}10`, borderRadius: 8, padding: "8px 10px" }}>
                  <span style={{ fontSize: 9, color: C.miracle, fontFamily: mono, fontWeight: 700 }}>🙏 PRAYER</span>
                  <p style={{ fontSize: 12, color: C.green, margin: "3px 0 0", fontStyle: "italic", lineHeight: 1.5 }}>{briefing.inspiring.prayer}</p>
                </div>
              </div>
            )}

            {/* 📍 LOCAL NEWS */}
            {briefing.local?.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "16px 0 6px" }}>
                  <span style={{ fontSize: 14 }}>📍</span>
                  <span style={{ fontSize: 10, fontFamily: mono, color: C.gold, textTransform: "uppercase", letterSpacing: 1 }}>Local — {briefingPrefs.local || "Your Area"}</span>
                </div>
                {briefing.local.map((item, i) => (
                  <div key={`local-${i}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 6, borderLeft: `3px solid ${C.gold}` }}>
                    <span style={{ fontSize: 8, color: C.dim, fontFamily: mono, textTransform: "uppercase" }}>{item.category}</span>
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: C.dim, margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
                    <p style={{ fontSize: 11, color: C.purple, margin: 0, fontStyle: "italic" }}>🙏 {item.prayer}</p>
                  </div>
                ))}
              </>
            )}

            {/* 🗺️ REGIONAL NEWS */}
            {briefing.regional?.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "16px 0 6px" }}>
                  <span style={{ fontSize: 14 }}>🗺️</span>
                  <span style={{ fontSize: 10, fontFamily: mono, color: C.blue, textTransform: "uppercase", letterSpacing: 1 }}>Regional — {briefingPrefs.region || "Your Region"}</span>
                </div>
                {briefing.regional.map((item, i) => (
                  <div key={`reg-${i}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 6, borderLeft: `3px solid ${C.blue}` }}>
                    <span style={{ fontSize: 8, color: C.dim, fontFamily: mono, textTransform: "uppercase" }}>{item.category}</span>
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: C.dim, margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
                    <p style={{ fontSize: 11, color: C.purple, margin: 0, fontStyle: "italic" }}>🙏 {item.prayer}</p>
                  </div>
                ))}
              </>
            )}

            {/* 🌍 GLOBAL NEWS */}
            {briefing.global?.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "16px 0 6px" }}>
                  <span style={{ fontSize: 14 }}>🌍</span>
                  <span style={{ fontSize: 10, fontFamily: mono, color: C.miracle, textTransform: "uppercase", letterSpacing: 1 }}>Global</span>
                </div>
                {briefing.global.map((item, i) => (
                  <div key={`glob-${i}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 6, borderLeft: `3px solid ${C.miracle}` }}>
                    <span style={{ fontSize: 8, color: C.dim, fontFamily: mono, textTransform: "uppercase" }}>{item.category}</span>
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: C.dim, margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
                    <p style={{ fontSize: 11, color: C.purple, margin: 0, fontStyle: "italic" }}>🙏 {item.prayer}</p>
                  </div>
                ))}
              </>
            )}

            {/* Verse of Encouragement */}
            {briefing.verse_of_encouragement && (
              <div style={{ background: `${C.gold}06`, border: `1px solid ${C.gold}20`, borderRadius: 10, padding: 14, margin: "12px 0", textAlign: "center" }}>
                <p style={{ fontSize: 14, color: C.text, margin: "0 0 4px", fontStyle: "italic", lineHeight: 1.6 }}>"{briefing.verse_of_encouragement.text}"</p>
                <span style={{ fontSize: 10, color: C.gold, fontFamily: mono }}>— {briefing.verse_of_encouragement.ref}</span>
              </div>
            )}

            {/* Closing Briefing Prayer */}
            {briefing.closing_prayer && (
              <div style={{ background: `${C.purple}08`, border: `1px solid ${C.purple}25`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                <div style={{ fontSize: 9, fontFamily: mono, color: C.purple, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>🙏 Prayer for Today's World</div>
                <p style={{ fontSize: 13, color: C.text, margin: 0, fontStyle: "italic", lineHeight: 1.7 }}>{briefing.closing_prayer}</p>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => { addToDoc("briefing", `Briefing ${briefing.date || "Today"}`, `DAILY FAITH BRIEFING\n\n✨ ${briefing.inspiring?.headline}\n${briefing.inspiring?.summary}\n🙏 ${briefing.inspiring?.prayer}\n\n${(briefing.global||[]).map(g=>`🌍 ${g.headline}\n${g.summary}\n🙏 ${g.prayer}`).join("\n\n")}\n\n${briefing.closing_prayer||""}`); setShowBriefing(false); }} style={{ flex: 1, padding: 10, background: `${C.green}12`, border: `1px solid ${C.green}30`, borderRadius: 8, color: C.green, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font }}>📄 Save to Doc</button>
              <button onClick={() => setShowBriefing(false)} style={{ flex: 1, padding: 10, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: font }}>✝ Start Studying</button>
            </div>

            <AIDisclaimer type="briefing" />
          </div>
        </div>
      )}

      {/* ═══ FIRST-TIME ONBOARDING ═══ */}
      {showOnboarding && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(45,36,22,0.7)", backdropFilter: "blur(6px)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.card, borderRadius: 20, padding: 28, width: "100%", maxWidth: 360, textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✝</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: "0 0 6px", fontFamily: font }}>Welcome to LordsGuide</h2>
            <p style={{ fontSize: 13, color: C.dim, margin: "0 0 16px" }}>Here's how to prepare your first sermon:</p>

            {[
              { icon: "✏️", title: "Enter a passage — or describe what you need", desc: "Type 'Romans 8:28' or tap 🔍 to search by topic like 'God's plan for my life'" },
              { icon: "🎤", title: "Tap 'Generate Sermon'", desc: "AI builds a complete 3-point outline with illustrations and applications in 60 seconds" },
              { icon: "📝", title: "Collect notes → Compile", desc: "Save the best parts with '+ Doc', add your own notes, then tap 'AI Compile' for a full preachable sermon" },
            ].map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 10, textAlign: "left", marginBottom: 10, padding: 8, background: C.surface, borderRadius: 10 }}>
                <div style={{ fontSize: 22, flexShrink: 0, paddingTop: 2 }}>{s.icon}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.4, marginTop: 2 }}>{s.desc}</div>
                </div>
              </div>
            ))}

            <button onClick={() => setShowOnboarding(false)} style={{ width: "100%", padding: 14, background: C.gold, border: "none", borderRadius: 12, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font, marginTop: 8 }}>Got it — let's go! ✝</button>
          </div>
        </div>
      )}

      {/* ═══ FLOATING SERMON NOTES PREVIEW ═══ */}
      {docBlocks.length > 0 && screen !== "document" && screen !== "landing" && screen !== "podium" && !showBlessingModal && !showClosingPrayer && (
        <div style={{ position: "fixed", bottom: 56, left: 0, right: 0, zIndex: 100, padding: "0 12px" }}>
          <div style={{ background: C.card, border: `1px solid ${C.gold}25`, borderRadius: "12px 12px 0 0", boxShadow: "0 -4px 20px rgba(0,0,0,0.08)", maxHeight: showNotesPreview ? 240 : 42, overflow: "hidden", transition: "max-height 0.3s ease" }}>
            <button onClick={() => setShowNotesPreview(!showNotesPreview)} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.gold }}>📄 Sermon Notes ({docBlocks.length})</span>
              <span style={{ fontSize: 10, color: C.dim }}>{showNotesPreview ? "▼ Hide" : "▲ Preview"}</span>
            </button>
            {showNotesPreview && (
              <div style={{ padding: "0 14px 10px", maxHeight: 190, overflowY: "auto" }}>
                {docBlocks.slice(-4).map(b => (
                  <div key={b.id} style={{ fontSize: 11, color: C.text, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ color: C.gold, fontWeight: 600, fontSize: 9, fontFamily: mono }}>{b.label}:</span> {b.content.slice(0, 80)}{b.content.length > 80 ? "..." : ""}
                  </div>
                ))}
                <button onClick={() => setScreen("document")} style={{ width: "100%", marginTop: 6, padding: 8, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 6, color: C.gold, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Open Full Notes → Compile Sermon</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ VIRAL BLESSING MODAL ═══ */}
      {showBlessingModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(45,36,22,0.6)", backdropFilter: "blur(8px)", zIndex: 280, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.card, border: `1px solid ${C.gold}25`, borderRadius: 20, padding: 28, width: "100%", maxWidth: 380, textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", animation: "fadeUp 0.5s ease" }}>

            {showBlessingModal === "giver" ? (
              <>
                <div style={{ fontSize: 44, marginBottom: 8 }}>🕊️</div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: "0 0 6px", fontFamily: font }}>You Just Blessed {blessingData.receiverCount === 1 ? "Someone" : `${blessingData.receiverCount} People`}</h2>
                <p style={{ fontSize: 14, color: C.dim, margin: "0 0 14px", lineHeight: 1.6 }}>Your purchase has gifted free access to {blessingData.receiverCount === 1 ? "a pastor" : `${blessingData.receiverCount} pastors`} who {blessingData.receiverCount === 1 ? "can't" : "can't"} afford study tools. {blessingData.receiverCount === 1 ? "They" : "They"} will be studying God's Word because of your generosity.</p>

                <div style={{ background: C.warm, borderRadius: 12, padding: 14, marginBottom: 14 }}>
                  <p style={{ fontSize: 14, color: C.text, margin: 0, fontStyle: "italic", fontFamily: font, lineHeight: 1.7 }}>"Freely ye have received, freely give."</p>
                  <span style={{ fontSize: 11, color: C.gold }}>— Matthew 10:8 KJV</span>
                </div>

                <p style={{ fontSize: 13, color: C.text, margin: "0 0 14px", lineHeight: 1.5 }}>You are in the prayers of those receiving this gift. Would you like to spread the blessing further?</p>

                <button onClick={() => shareBlessing("giver")} style={{ width: "100%", padding: 14, background: C.gold, border: "none", borderRadius: 12, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: sans, marginBottom: 8 }}>🕊️ Share the Blessing</button>
                <button onClick={() => setShowBlessingModal(null)} style={{ width: "100%", padding: 10, background: "none", border: `1px solid ${C.border}`, borderRadius: 10, color: C.dim, fontSize: 13, cursor: "pointer", fontFamily: sans }}>Maybe later</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 44, marginBottom: 8 }}>✝</div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: "0 0 6px", fontFamily: font }}>You've Been Blessed</h2>
                <p style={{ fontSize: 14, color: C.dim, margin: "0 0 14px", lineHeight: 1.6 }}>A brother or sister in Christ — someone you may never meet — has gifted you free access to LordsGuide. They prayed for you and gave so you could study God's Word.</p>

                <div style={{ background: C.warm, borderRadius: 12, padding: 14, marginBottom: 14 }}>
                  <p style={{ fontSize: 14, color: C.text, margin: 0, fontStyle: "italic", fontFamily: font, lineHeight: 1.7 }}>"Bear ye one another's burdens, and so fulfil the law of Christ."</p>
                  <span style={{ fontSize: 11, color: C.gold }}>— Galatians 6:2 KJV</span>
                </div>

                <p style={{ fontSize: 13, color: C.text, margin: "0 0 4px", lineHeight: 1.5 }}>You are a blessing already. Share this gift with your circle — pastors, students, believers who need tools to study the Word.</p>
                <p style={{ fontSize: 12, color: C.green, margin: "0 0 14px", fontWeight: 600 }}>The power of one. The power of faith.</p>

                <button onClick={() => shareBlessing("receiver")} style={{ width: "100%", padding: 14, background: C.gold, border: "none", borderRadius: 12, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: sans, marginBottom: 8 }}>🌍 Share the Blessing with My Circle</button>
                <button onClick={() => setShowBlessingModal(null)} style={{ width: "100%", padding: 10, background: "none", border: `1px solid ${C.border}`, borderRadius: 10, color: C.dim, fontSize: 13, cursor: "pointer", fontFamily: sans }}>Maybe later</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ CLOSING PRAYER MODAL ═══ */}
      {showClosingPrayer && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.card, border: `1px solid ${C.gold}30`, borderRadius: 16, padding: 28, width: "100%", maxWidth: 380, textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🙏</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: C.goldL, margin: "0 0 12px" }}>{t.closingPrayer}</h2>
            <p style={{ fontSize: 14, color: C.text, margin: "0 0 16px", lineHeight: 1.8, fontStyle: "italic" }}>{getSessionPrayer()}</p>
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 8 }}>
              <p style={{ fontSize: 11, color: C.gold, fontFamily: mono, margin: "0 0 12px" }}>"{dailyQuote.text}" — {dailyQuote.ref}</p>
            </div>
            <button onClick={() => { setShowClosingPrayer(false); setScreen("landing"); }} style={{ width: "100%", padding: 14, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 10, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font }}>Amen 🕊️</button>
          </div>
        </div>
      )}

      {/* ═══ NAV ═══ */}
      {!["landing", "pricing", "podium"].includes(screen) && (
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", zIndex: 100, paddingBottom: "env(safe-area-inset-bottom, 6px)", boxShadow: "0 -1px 6px rgba(0,0,0,0.04)" }} role="navigation" aria-label="Main navigation">
          {[
            { id: "home", icon: "✝", label: t.study },
            { id: "bible", icon: "📖", label: t.bible },
            { id: "sources", icon: "📚", label: t.sources },
            { id: "community", icon: "🌍", label: t.shared },
            { id: "document", icon: "📝", label: `${t.doc}${docBlocks.length?` (${docBlocks.length})`:""}`},
          ].map(n => (
            <button key={n.id} onClick={() => { if(n.id==="bible"&&!bibleText) loadBible(); if(n.id==="community"){ loadSermons(); loadPrayers(); } setScreen(n.id); }} aria-label={n.label} aria-current={screen===n.id?"page":undefined} style={{
              flex: 1, padding: "7px 0 5px", background: "none", border: "none",
              color: screen===n.id?C.gold:C.dim, cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
            }}>
              <span style={{ fontSize: 17 }}>{n.icon}</span>
              <span style={{ fontSize: 9, fontFamily: mono, fontWeight: screen===n.id?700:400 }}>{n.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

// ── ErrorBoundary Wrapper ──
export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
