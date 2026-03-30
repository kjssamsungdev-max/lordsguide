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

// Utilities exported for testing
export { sanitize, isValidEmail, isValidPassage, validateSermon, validateTopical, validateSource, validateIllustrations, parseAIJSON, lruEvict, TIER_LIMITS, INPUT_LIMITS };

// ── F1: Tier limits & gating ──
const TIER_LIMITS = {
  miracle: { aiCallsPerDay: 3, sourcesPerDay: 1, podium: false, illustrations: false, songsPerDay: 1 },
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
  return /^(\d\s)?[A-Za-z]+(\s[A-Za-z]+){0,3}\s\d+/.test(p.trim());
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
let API_URL = "https://api.anthropic.com/v1/messages";
try { if (import.meta?.env?.VITE_ANTHROPIC_PROXY_URL) API_URL = import.meta.env.VITE_ANTHROPIC_PROXY_URL; } catch {}

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
async function fetchBibleText(ref) {
  try {
    const r = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=kjv`);
    if (!r.ok) return { text: `Could not fetch: ${ref} (${r.status})`, ref, verses: [], error: true };
    const d = await r.json();
    if (d.error) return { text: `Not found: ${ref}`, ref, verses: [], error: true };
    return { text: d.text, ref: d.reference, verses: d.verses || [], error: false };
  } catch { return { text: `Could not fetch: ${ref}. Check connection.`, ref, verses: [], error: true }; }
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
  en: { study: "Study", bible: "Bible", sources: "Sources", shared: "Shared", doc: "Doc", generate: "Generate Sermon", welcome: "Welcome", signIn: "Sign in to start", offline: "Offline", prayer: "Prayer", closingPrayer: "Closing Prayer" },
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
  { id: "water", icon: "💧", name: "Living Water Wells", desc: "Clean water for communities", goal: 2000, color: "#22d3ee" },
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
  { id: "family", label: "👨‍👩‍👧‍👦 Family", color: "#22d3ee" },
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
  { id: "youth", icon: "🧑‍🤝‍🧑", title: "Next Generation", desc: "Young people finding faith and purpose", region: "Every School", verse: "Psalm 71:17", color: "#22d3ee" },
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

  // Study
  const [studyMode, setStudyMode] = useState(null);
  const [topic, setTopic] = useState(null);
  const [customTopic, setCustomTopic] = useState("");
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
  const [gameState, setGameState] = useState({ active: null, score: 0, qIdx: 0, answers: [], quizData: null });
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
  const loadBible = async (ref) => {
    const r = ref || passage;
    if (!validatePassage(r)) return;
    setLoading("bible", true);
    try {
      const cached = cacheGet(`bible_${r}`);
      if (cached) { setBibleText(cached); setLoading("bible", false); return; }
      const data = await fetchBibleText(r);
      setBibleText(data);
      if (!data.error) cacheSet(`bible_${r}`, data);
    } catch(e) { setError("Failed to load Bible text: " + e.message); } finally { setLoading("bible", false); }
  };

  // ── F3+F11: AI generation with validation + retry ──
  const generate = async () => {
    if (!validatePassage(passage)) return;
    if (!(await checkAndTrack("ai"))) return;
    const op = "generate"; const cacheKey = `gen_${studyMode}_${passage}_${topic||""}`;
    // Offline fallback
    const cached = cacheGet(cacheKey);
    if (!isOnline && cached) { setResult(cached); setResultType(studyMode); setScreen("results"); showToast("📴 From cache"); return; }
    setLoading(op, true); setError(null);
    try {
      const p = sanitize(passage, INPUT_LIMITS.passage);
      let raw;
      if (studyMode === "sermon") { raw = await callClaude(P.sermon, `Passage: ${p}\nStyle: expository`); }
      else { const t = topic === "Custom..." ? sanitize(customTopic, INPUT_LIMITS.topic) : topic; raw = await callClaude(P.topical, `Topic: ${t}\nStarting passage: ${p}`); }
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
    { id: "science", label: "🔬 Faith & Science", color: "#22d3ee" },
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
                <div><div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{step.title}</div><div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>{step.desc}</div></div>
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
                  <span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{usage.aiCalls}/3 AI calls today</span>
                </div>
              )}
              {!user && (
                <button onClick={() => setAuthScreen("signup")} style={{ width: "100%", padding: 10, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 8, color: C.goldL, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, marginBottom: 10 }}>✝ Sign in to start studying</button>
              )}
              <div style={secH}>Scripture Passage</div>
              <div style={{ display: "flex", gap: 6, marginBottom: passageError ? 4 : 14 }}>
                <input value={passage} onChange={e => { setPassage(e.target.value); setPassageError(null); }} placeholder="e.g. Joshua 14:6-15" aria-label="Bible passage" maxLength={INPUT_LIMITS.passage} style={{ ...inputS, flex: 1, borderColor: passageError ? C.red : C.border }} />
                <button onClick={() => { if(validatePassage(passage)) { loadBible(); setScreen("bible"); }}} style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}35`, color: C.blue, borderRadius: 8, padding: "0 14px", fontSize: 12, fontFamily: mono, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>📖 Read</button>
              </div>
              {passageError && <p role="alert" style={{ fontSize: 11, color: C.red, margin: "0 0 10px" }}>⚠ {passageError}</p>}

              <div style={secH}>Study Mode</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {[{ id: "sermon", icon: "🎤", label: "Sermon" }, { id: "topical", icon: "🔗", label: "Topical" }, { id: "free", icon: "📝", label: "Free" }].map(m => (
                  <button key={m.id} onClick={() => setStudyMode(m.id)} aria-pressed={studyMode===m.id} style={{ flex: 1, padding: "14px 6px", background: studyMode===m.id?`${C.gold}12`:C.card, border: studyMode===m.id?`1px solid ${C.gold}35`:`1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 22, marginBottom: 3 }}>{m.icon}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: studyMode===m.id?C.goldL:C.text }}>{m.label}</div>
                  </button>
                ))}
              </div>

              {studyMode === "topical" && (
                <>
                  <div style={secH}>Topic</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
                    {TOPICS.map(t => <button key={t} onClick={() => setTopic(t)} aria-pressed={topic===t} style={{ ...tagS(topic===t?C.blue:C.dim), cursor: "pointer", background: topic===t?`${C.blue}18`:C.card }}>{t}</button>)}
                  </div>
                  {topic === "Custom..." && <input value={customTopic} onChange={e => setCustomTopic(e.target.value)} placeholder="Your topic..." maxLength={INPUT_LIMITS.topic} style={{ ...inputS, marginBottom: 14 }} />}
                </>
              )}

              {studyMode && studyMode !== "free" && (
                <button onClick={generate} disabled={isLoading("generate")} aria-busy={isLoading("generate")} style={{
                  width: "100%", padding: 14, background: isLoading("generate") ? C.card : `linear-gradient(135deg, ${C.gold}, #a0832e)`,
                  border: "none", borderRadius: 10, color: isLoading("generate") ? C.dim : "#fff",
                  fontSize: 15, fontWeight: 700, cursor: isLoading("generate") ? "default" : "pointer", fontFamily: font, marginBottom: 8,
                }}>{isLoading("generate") ? "⏳ Generating..." : studyMode === "sermon" ? "⚡ Generate Sermon" : "⚡ Build Study"}</button>
              )}
              {studyMode === "free" && <button onClick={() => setScreen("sources")} style={{ width: "100%", padding: 14, background: `${C.blue}12`, border: `1px solid ${C.blue}30`, borderRadius: 10, color: C.blue, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font }}>📚 Open Sources</button>}
            </div>
          )}

          {/* BIBLE */}
          {screen === "bible" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <button onClick={() => setScreen("home")} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 10px", fontFamily: font }}>← Back</button>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                <input value={passage} onChange={e => { setPassage(e.target.value); setPassageError(null); }} placeholder="e.g. John 3:16" maxLength={INPUT_LIMITS.passage} style={{ ...inputS, flex: 1, borderColor: passageError ? C.red : C.border }} />
                <button onClick={() => loadBible()} style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}35`, color: C.blue, borderRadius: 8, padding: "0 14px", fontSize: 12, fontFamily: mono, cursor: "pointer" }}>Go</button>
              </div>
              {passageError && <p role="alert" style={{ fontSize: 11, color: C.red, margin: "0 0 8px" }}>⚠ {passageError}</p>}
              {isLoading("bible") && <p style={{ color: C.dim, textAlign: "center", padding: "20px 0" }}>Loading...</p>}
              {bibleText && !isLoading("bible") && (
                <div style={{ ...cardS, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, color: C.goldL, margin: 0 }}>📖 {bibleText.ref}</h2>
                    <AddBtn label={`Scripture: ${bibleText.ref}`} content={bibleText.text} />
                  </div>
                  {bibleText.verses?.length > 0 ? bibleText.verses.map((v, i) => (
                    <div key={i} style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 10, color: C.gold, fontFamily: mono, fontWeight: 700, minWidth: 18, paddingTop: 3 }}>{v.verse}</span>
                      <p style={{ fontSize: 15, color: "#e2e8f0", margin: 0, lineHeight: 1.8, flex: 1 }}>{v.text}</p>
                    </div>
                  )) : <p style={{ fontSize: 15, color: "#e2e8f0", margin: 0, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{bibleText.text}</p>}
                  <button onClick={() => addToDoc("scripture", `${bibleText.ref}`, bibleText.text)} style={{ width: "100%", marginTop: 12, padding: 10, background: `${C.green}12`, border: `1px solid ${C.green}30`, borderRadius: 8, color: C.green, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font }}>+ Add to Doc</button>
                </div>
              )}
            </div>
          )}

          {/* SOURCES */}
          {screen === "sources" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              {!activeSource ? (
                <>
                  <button onClick={() => setScreen("home")} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 10px", fontFamily: font }}>← Back</button>
                  <h2 style={{ fontSize: 16, fontWeight: 600, color: C.goldL, margin: "0 0 12px" }}>📚 Sources for {passage}</h2>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {SOURCES.map(s => <button key={s.id} onClick={() => fetchSource(s.id)} aria-label={`Load ${s.label}`} style={{ ...cardS, cursor: "pointer", textAlign: "left", padding: "14px 10px" }}><div style={{ fontSize: 22, marginBottom: 4 }}>{s.icon}</div><div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.label}</div></button>)}
                  </div>
                </>
              ) : (
                <>
                  <button onClick={() => { setActiveSource(null); setSourceResult(null); setError(null); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer", padding: "0 0 10px", fontFamily: font }}>← Sources</button>
                  {isLoading("source") && <p style={{ color: C.dim, textAlign: "center", padding: "30px 0" }}>Loading {SOURCES.find(s=>s.id===activeSource)?.label}...</p>}
                  {sourceResult && (
                    <div>
                      <h3 style={{ fontSize: 15, fontWeight: 600, color: SOURCES.find(s=>s.id===activeSource)?.color, margin: "0 0 10px" }}>{SOURCES.find(s=>s.id===activeSource)?.icon} {SOURCES.find(s=>s.id===activeSource)?.label}: {passage}</h3>
                      {activeSource === "commentary" && sourceResult.entries?.map((e,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 10, color: C.gold, fontFamily: mono, fontWeight: 700 }}>{e.verse}</span><p style={{ fontSize: 13, color: "#cbd5e1", margin: "4px 0 0", lineHeight: 1.7 }}>{e.text}</p></div><AddBtn small label={`CMT ${e.verse}`} content={`${e.verse}: ${e.text}`} /></div></div>)}
                      {activeSource === "lexicon" && sourceResult.words?.map((w,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: C.goldL }}>{w.english}</div><div style={{ fontSize: 11, color: C.purple, fontFamily: mono }}>{w.original} ({w.transliteration}) • {w.strongs}</div><p style={{ fontSize: 12, color: "#cbd5e1", margin: "4px 0", lineHeight: 1.5 }}>{w.definition}</p>{w.theological_significance && <p style={{ fontSize: 11, color: C.gold, margin: 0, fontStyle: "italic" }}>↳ {w.theological_significance}</p>}</div><AddBtn small label={w.english} content={`${w.english} (${w.original}) ${w.strongs}: ${w.definition}`} /></div></div>)}
                      {activeSource === "compare" && sourceResult.translations?.map((t,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={tagS(C.blue)}>{t.version}</span><p style={{ fontSize: 14, color: "#e2e8f0", margin: "6px 0", lineHeight: 1.7 }}>{t.text}</p>{t.note && <p style={{ fontSize: 10, color: C.dim, margin: 0, fontStyle: "italic" }}>{t.note}</p>}</div><AddBtn small label={t.version} content={`[${t.version}] ${t.text}`} /></div></div>)}
                      {activeSource === "dictionary" && sourceResult.entries?.map((e,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{e.term}</span><span style={{ fontSize: 9, color: C.red, fontFamily: mono, marginLeft: 6, textTransform: "uppercase" }}>{e.category}</span><p style={{ fontSize: 12, color: "#cbd5e1", margin: "4px 0 0", lineHeight: 1.6 }}>{e.definition}</p></div><AddBtn small label={e.term} content={`${e.term}: ${e.definition}`} /></div></div>)}
                      {activeSource === "references" && sourceResult.groups?.map((g,i) => <div key={i} style={{ marginBottom: 10 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#22d3ee", marginBottom: 4 }}>{g.theme}</div>{g.refs?.map((r,j) => <div key={j} style={{ ...cardS, display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 11, color: C.gold, fontFamily: mono, fontWeight: 700 }}>{r.ref}</span> <span style={{ fontSize: 11, color: "#9ca3af" }}>{r.connection}</span></div><AddBtn small label={r.ref} content={`${r.ref}: ${r.connection}`} /></div>)}</div>)}
                      {activeSource === "devotional" && <><div style={cardS}><div style={{ fontSize: 15, fontWeight: 600, color: "#86efac", marginBottom: 6 }}>{sourceResult.theme}</div><p style={{ fontSize: 13, color: "#cbd5e1", margin: 0, lineHeight: 1.8, whiteSpace: "pre-line" }}>{sourceResult.reflection}</p></div>{sourceResult.prayer && <div style={{ ...cardS, borderLeft: `3px solid ${C.purple}` }}><span style={{ fontSize: 9, color: C.purple, fontFamily: mono, fontWeight: 700 }}>PRAYER</span><p style={{ fontSize: 13, color: "#cbd5e1", margin: "4px 0 0", fontStyle: "italic", lineHeight: 1.7 }}>{sourceResult.prayer}</p></div>}</>}
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
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <button onClick={() => setScreen("home")} style={{ flex: 1, padding: 8, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.dim, fontSize: 12, cursor: "pointer", fontFamily: font }}>↩ New</button>
                <button onClick={() => setScreen("sources")} style={{ flex: 1, padding: 8, background: `${C.blue}10`, border: `1px solid ${C.blue}25`, borderRadius: 6, color: C.blue, fontSize: 12, cursor: "pointer", fontFamily: font }}>📚 Sources</button>
                {result.points && <button onClick={() => { if(!canAccess("podium")){showToast("Podium mode is a Shepherd feature. Upgrade to unlock.");return;} setPodiumSection(0); setScreen("podium"); }} style={{ flex: 1, padding: 8, background: `${C.gold}10`, border: `1px solid ${C.gold}25`, borderRadius: 6, color: C.gold, fontSize: 12, cursor: "pointer", fontFamily: font }}>📺 Podium</button>}
                {resultType === "sermon" && <button onClick={shareCurrentSermon} style={{ flex: 1, padding: 8, background: `${C.miracle}10`, border: `1px solid ${C.miracle}25`, borderRadius: 6, color: C.miracle, fontSize: 12, cursor: "pointer", fontFamily: font }}>🕊️</button>}
              </div>
              {/* Translate bar */}
              {lang !== "en" && (
                <button onClick={() => translateResult(lang)} disabled={isLoading("translate")} style={{ width: "100%", padding: 8, background: isLoading("translate")?C.card:`${C.blue}10`, border: `1px solid ${C.blue}25`, borderRadius: 6, color: isLoading("translate")?C.dim:C.blue, fontSize: 11, fontWeight: 600, cursor: isLoading("translate")?"default":"pointer", fontFamily: font, marginBottom: 10 }}>{isLoading("translate") ? "⏳ Translating..." : `🌍 Translate to ${LANGUAGES.find(l=>l.code===lang)?.native}`}</button>
              )}

              {resultType === "sermon" && result.title && (
                <>
                  <div style={{ borderLeft: `3px solid ${C.gold}`, paddingLeft: 12, marginBottom: 14 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: C.goldL, margin: "0 0 3px" }}>{result.title}</h2>
                    <p style={{ fontSize: 13, color: "#a1a1aa", margin: 0, fontStyle: "italic" }}>{result.big_idea}</p>
                  </div>
                  <div style={cardS}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 9, color: C.gold, fontFamily: mono, fontWeight: 700 }}>INTRODUCTION</span><AddBtn small label="Intro" content={`Hook: ${result.introduction?.hook}\nContext: ${result.introduction?.context}\nThesis: ${result.introduction?.thesis}`} /></div>
                    <p style={{ fontSize: 13, color: "#e2e8f0", margin: "6px 0 3px", lineHeight: 1.7 }}>🎣 {result.introduction?.hook}</p>
                    <p style={{ fontSize: 12, color: "#9ca3af", margin: "3px 0", lineHeight: 1.5 }}>{result.introduction?.context}</p>
                    <p style={{ fontSize: 13, color: C.goldL, margin: "3px 0 0", fontWeight: 500 }}>→ {result.introduction?.thesis}</p>
                  </div>
                  {result.points?.map((pt,i) => (
                    <div key={i} style={cardS}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                          <span style={{ width: 22, height: 22, borderRadius: "50%", background: `${C.gold}20`, border: `1.5px solid ${C.gold}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: C.gold, fontFamily: mono, flexShrink: 0 }}>{i+1}</span>
                          <div><div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{pt.heading}</div><div style={{ fontSize: 10, color: C.blue, fontFamily: mono }}>{pt.verses}</div></div>
                        </div>
                        <AddBtn small label={`Pt ${i+1}`} content={`${pt.heading} (${pt.verses})\n${pt.explanation}\n💡 ${pt.illustration}\n✋ ${pt.application}`} />
                      </div>
                      <p style={{ fontSize: 13, color: "#cbd5e1", margin: "8px 0 4px", lineHeight: 1.7 }}>{pt.explanation}</p>
                      <p style={{ fontSize: 12, color: C.purple, margin: "0 0 3px" }}>💡 {pt.illustration}</p>
                      <p style={{ fontSize: 12, color: C.green, margin: 0 }}>✋ {pt.application}</p>
                    </div>
                  ))}
                  <div style={cardS}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 9, color: C.gold, fontFamily: mono, fontWeight: 700 }}>CONCLUSION</span><AddBtn small label="Conclusion" content={`${result.conclusion?.summary}\n${result.conclusion?.call}`} /></div>
                    <p style={{ fontSize: 13, color: "#cbd5e1", margin: "6px 0 3px", lineHeight: 1.7 }}>{result.conclusion?.summary}</p>
                    <p style={{ fontSize: 13, color: C.goldL, margin: "3px 0", fontWeight: 500 }}>{result.conclusion?.call}</p>
                  </div>
                  {result.cross_refs?.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>{result.cross_refs.map((r,i) => <button key={i} onClick={() => addToDoc("ref", r, `Cross Ref: ${r}`)} style={{ ...tagS(C.blue), cursor: "pointer" }}>{r}</button>)}</div>}
                  {result.questions?.length > 0 && <div style={cardS}><span style={{ fontSize: 9, color: C.dim, fontFamily: mono, fontWeight: 700 }}>DISCUSSION</span>{result.questions.map((q,i) => <p key={i} style={{ fontSize: 12, color: "#cbd5e1", margin: "5px 0 0" }}>{i+1}. {q}</p>)}</div>}
                  <AIDisclaimer type="sermon" />
                </>
              )}

              {resultType === "topical" && result.title && (
                <>
                  <div style={{ borderLeft: `3px solid ${C.blue}`, paddingLeft: 12, marginBottom: 14 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: "#93b4f5", margin: "0 0 3px" }}>{result.title}</h2>
                    <p style={{ fontSize: 13, color: "#a1a1aa", margin: 0 }}>{result.definition}</p>
                  </div>
                  {result.passages?.map((p,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 10, fontFamily: mono, fontWeight: 700, color: p.testament==="OT"?C.gold:C.blue }}>{p.ref}</span><p style={{ fontSize: 13, color: "#cbd5e1", margin: "4px 0", lineHeight: 1.7 }}>{p.teaching}</p><p style={{ fontSize: 11, color: C.goldL, margin: 0, fontStyle: "italic" }}>💡 {p.insight}</p></div><AddBtn small label={p.ref} content={`${p.ref}: ${p.teaching}`} /></div></div>)}
                  {result.misconceptions?.map((m,i) => <div key={i} style={cardS}><p style={{ fontSize: 12, color: C.red, margin: "0 0 3px", textDecoration: "line-through", opacity: 0.7 }}>✕ {m.myth}</p><p style={{ fontSize: 12, color: C.green, margin: 0 }}>✓ {m.truth}</p></div>)}
                  {result.applications?.map((a,i) => <div key={i} style={cardS}><div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{a.situation}</div><p style={{ fontSize: 12, color: "#9ca3af", margin: "3px 0" }}>{a.principle}</p><p style={{ fontSize: 12, color: C.green, margin: 0 }}>→ {a.action}</p></div>)}
                  <AIDisclaimer type="topical" />
                </>
              )}
            </div>
          )}

          {/* DOCUMENT */}
          {screen === "document" && (
            <div style={{ animation: "fadeUp 0.3s ease" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: C.goldL, margin: 0 }}>📄 Document</h2>
                {docBlocks.length > 0 && <button onClick={exportDoc} aria-label="Export document" style={{ background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>📋 Export</button>}
              </div>
              <input value={docTitle} onChange={e => setDocTitle(e.target.value)} placeholder={`Study: ${passage}`} aria-label="Document title" style={{ ...inputS, fontSize: 16, fontWeight: 600, color: C.goldL, marginBottom: 10 }} />
              {docBlocks.length === 0 ? (
                <div style={{ textAlign: "center", padding: "30px 0", color: C.dim }}><p style={{ fontSize: 13, margin: 0 }}>Tap "+ Doc" to start building.</p></div>
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
                  ) : <p style={{ fontSize: 13, color: "#cbd5e1", margin: 0, lineHeight: 1.7, whiteSpace: "pre-line" }}>{b.content}</p>}
                </div>
              ))}
              <div style={{ marginTop: 12 }}>
                <div style={secH}>Personal Note</div>
                <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Notes, reflections..." maxLength={INPUT_LIMITS.sermonBody} aria-label="Add note" style={{ ...inputS, minHeight: 60, fontSize: 13, resize: "vertical" }} />
                <button onClick={() => { if(noteText.trim()) { addToDoc("note","Note",noteText); setNoteText(""); }}} disabled={!noteText.trim()} style={{ width: "100%", marginTop: 6, padding: 10, background: noteText.trim()?`${C.green}12`:C.card, border: `1px solid ${noteText.trim()?`${C.green}25`:C.border}`, borderRadius: 8, color: noteText.trim()?C.green:C.dim, fontSize: 13, fontWeight: 600, cursor: noteText.trim()?"pointer":"default", fontFamily: font }}>✍️ Add Note</button>
              </div>
              {docBlocks.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                  <button onClick={exportDoc} style={{ flex: 1, padding: 12, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: font }}>📋 Copy Doc</button>
                  <button onClick={() => { if(confirm("Clear all blocks?")) setDocBlocks([]); }} style={{ padding: "12px 14px", background: `${C.red}08`, border: `1px solid ${C.red}25`, borderRadius: 8, color: C.red, fontSize: 12, cursor: "pointer", fontFamily: mono }}>🗑️</button>
                </div>
              )}
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
                  <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 6, marginBottom: 10, WebkitOverflowScrolling: "touch" }} role="tablist">
                    {[{id:"prayer",icon:"🙏",l:"Prayer"},{id:"sermons",icon:"🎤",l:"Sermons"},{id:"songs",icon:"🎵",l:"Songs"},{id:"illustrations",icon:"💡",l:"Illustr."},{id:"kids",icon:"🌟",l:"Kids"},{id:"teens",icon:"🔥",l:"Teens"},{id:"games",icon:"🎮",l:"Games"},{id:"events",icon:"📅",l:"Events"},{id:"charity",icon:"💛",l:"Charity"},{id:"mentorship",icon:"🤝",l:"Mentors"},{id:"family",icon:"👨‍👩‍👧‍👦",l:"Family"}].map(t => (
                      <button key={t.id} role="tab" aria-selected={hubTab===t.id} onClick={() => setHubTab(t.id)} style={{ padding: "6px 10px", background: hubTab===t.id?`${C.gold}15`:C.card, border: hubTab===t.id?`1px solid ${C.gold}35`:`1px solid ${C.border}`, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                        <span style={{ fontSize: 13 }}>{t.icon}</span><span style={{ fontSize: 10, fontWeight: hubTab===t.id?700:400, color: hubTab===t.id?C.goldL:C.dim }}>{t.l}</span>
                      </button>
                    ))}
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
                              <div style={{ flex: 1, fontSize: 10, fontWeight: 600, color: st.glow ? "#e2e8f0" : C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{zone.name}</div>
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
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#e2e8f0", lineHeight: 1.2 }}>{f.title}</div>
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
                          <p style={{ fontSize: 12, color: "#e2e8f0", margin: "3px 0 0", lineHeight: 1.5 }}>{p.text}</p>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5 }}>
                          <span style={{ fontSize: 9, color: C.purple }}>{p.prayedBy || 0} praying</span>
                          <button onClick={() => prayForRequest(p.id)} aria-label="Join prayer" style={{ background: `${C.purple}12`, border: `1px solid ${C.purple}30`, color: C.purple, padding: "3px 10px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: font }}>🙏 I'm Praying</button>
                        </div>
                      </div>
                    ))}

                    <div style={{ ...cardS, textAlign: "center", marginTop: 6, background: `${C.gold}06`, borderColor: `${C.gold}20`, padding: 12 }}>
                      <p style={{ fontSize: 13, color: "#e2e8f0", margin: "0 0 3px", fontStyle: "italic", lineHeight: 1.5 }}>"If two of you shall agree on earth as touching any thing that they shall ask, it shall be done for them of my Father which is in heaven."</p>
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
                    <div style={{ ...cardS, padding: 14, textAlign: "center" }}>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#c4b5fd", margin: "0 0 8px" }}>🎵 AI Worship Song Writer</h3>
                      <input value={songRequest} onChange={e => setSongRequest(e.target.value)} placeholder="Theme, scripture, or feeling..." maxLength={INPUT_LIMITS.songReq} style={{ ...inputS, marginBottom: 6, textAlign: "center" }} />
                      <button onClick={generateSong} disabled={isLoading("song")||!songRequest.trim()} style={{ width: "100%", padding: 10, background: isLoading("song")?C.card:`linear-gradient(135deg, ${C.purple}, #7c3aed)`, border: "none", borderRadius: 8, color: isLoading("song")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("song")?"default":"pointer", fontFamily: font }}>{isLoading("song")?"⏳ Writing...":"🎵 Generate"}</button>
                    </div>
                    {songResult && <div style={{ ...cardS, padding: 14 }}><h4 style={{ fontSize: 15, fontWeight: 700, color: C.goldL, margin: "0 0 6px" }}>🎵 {songResult.title}</h4>{songResult.verses?.map((v,i) => <div key={i} style={{ marginBottom: 8, paddingLeft: 10, borderLeft: v.label?.toLowerCase().includes("chorus")?`3px solid ${C.gold}`:`2px solid ${C.border}` }}><div style={{ fontSize: 9, fontFamily: mono, color: v.label?.toLowerCase().includes("chorus")?C.gold:C.dim, fontWeight: 700, marginBottom: 3 }}>{v.label}</div>{v.lines?.map((l,j) => <p key={j} style={{ fontSize: 14, color: "#e2e8f0", margin: "1px 0", lineHeight: 1.6 }}>{l}</p>)}</div>)}<AIDisclaimer type="song" /></div>}
                  </>}

                  {/* ILLUSTRATIONS */}
                  {hubTab === "illustrations" && <>
                    <div style={{ ...cardS, padding: 14, background: `${C.gold}06` }}>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: C.goldL, margin: "0 0 8px", textAlign: "center" }}>💡 Sermon Illustrations</h3>
                      <input value={illusSearch} onChange={e => setIllusSearch(e.target.value)} placeholder="Topic or scripture..." maxLength={INPUT_LIMITS.songReq} style={{ ...inputS, marginBottom: 6, textAlign: "center" }} />
                      <button onClick={() => generateIllustrations(illusSearch)} disabled={isLoading("illus")||!illusSearch.trim()} style={{ width: "100%", padding: 10, background: isLoading("illus")?C.card:`linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: isLoading("illus")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("illus")?"default":"pointer", fontFamily: font }}>{isLoading("illus")?"⏳ Generating...":"💡 Generate 6 Illustrations"}</button>
                    </div>
                    {illusResult && <div>{illusResult.illustrations?.map((il,i) => <div key={i} style={cardS}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{il.title}</span><span style={{ fontSize: 8, color: C.dim, fontFamily: mono, marginLeft: 4 }}>{il.type?.replace("_"," ")}</span><p style={{ fontSize: 12, color: "#cbd5e1", margin: "4px 0", lineHeight: 1.6 }}>{il.content}</p><span style={{ fontSize: 9, color: C.gold }}>📖 {il.scripture_tie}</span></div><AddBtn small label={il.title} content={`${il.title}\n\n${il.content}\n\nScripture: ${il.scripture_tie}`} /></div></div>)}<AIDisclaimer type="illustration" /></div>}
                    {illustrations.length > 0 && <><div style={secH}>Library ({illustrations.length})</div>{filteredIllustrations.slice(0,15).map((il,i) => <div key={il.id||i} style={{ ...cardS, padding: 10 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><div style={{ flex: 1 }}><span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{il.title}</span><p style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 0", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{il.content}</p></div><AddBtn small label={il.title} content={il.content} /></div></div>)}</>}
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
                    {!gameState.active ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{GAME_CATS.map(g => <button key={g.id} onClick={() => startQuiz(g.id)} style={{ ...cardS, cursor: "pointer", textAlign: "center", padding: 12 }}><div style={{ fontSize: 22, marginBottom: 3 }}>{g.icon}</div><div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{g.name}</div></button>)}</div>
                    : gameState.qIdx < (gameState.quizData?.questions?.length||0) ? <div style={cardS}><div style={{ width: "100%", height: 3, background: C.border, borderRadius: 2, marginBottom: 10 }}><div style={{ width: `${(gameState.qIdx/gameState.quizData.questions.length)*100}%`, height: "100%", background: C.gold, borderRadius: 2 }}/></div><p style={{ fontSize: 15, color: "#e2e8f0", margin: "0 0 10px", fontWeight: 500 }}>{gameState.quizData.questions[gameState.qIdx].q}</p>{gameState.quizData.questions[gameState.qIdx].options.map((o,i) => <button key={i} onClick={() => answerQuiz(i)} style={{ width: "100%", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: "#e2e8f0", fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: font, marginBottom: 4 }}><span style={{ color: C.gold, fontFamily: mono, fontWeight: 700, marginRight: 6 }}>{String.fromCharCode(65+i)}</span>{o}</button>)}</div>
                    : <div style={{ textAlign: "center" }}><div style={{ fontSize: 40, marginBottom: 6 }}>{gameState.score>=6?"🏆":gameState.score>=4?"⭐":"📖"}</div><div style={{ fontSize: 28, fontWeight: 700, color: C.gold, fontFamily: mono }}>{gameState.score}/{gameState.quizData.questions.length}</div><button onClick={() => setGameState({active:null,score:0,qIdx:0,answers:[],quizData:null})} style={{ marginTop: 10, padding: 10, background: `linear-gradient(135deg, ${C.gold}, #a0832e)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: font, width: "100%" }}>🎮 Play Again</button></div>}
                    {isLoading("quiz") && <p style={{ textAlign: "center", color: C.dim }}>⏳ Generating quiz...</p>}
                  </>}

                  {/* EVENTS */}
                  {hubTab === "events" && <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><h3 style={{ fontSize: 14, fontWeight: 600, color: C.goldL, margin: 0 }}>📅 Events</h3><button onClick={() => setShowEventForm(!showEventForm)} style={{ background: `${C.gold}12`, border: `1px solid ${C.gold}25`, color: C.gold, padding: "4px 10px", borderRadius: 6, fontSize: 10, cursor: "pointer", fontFamily: mono }}>{showEventForm?"✕":"+ Post"}</button></div>
                    {showEventForm && <div style={{ ...cardS, padding: 12, marginBottom: 8 }}><input value={eventForm.title} onChange={e => setEventForm(f=>({...f,title:e.target.value}))} placeholder="Event name" maxLength={200} style={{ ...inputS, marginBottom: 5, fontSize: 13 }} /><div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 5 }}>{EVENT_TYPES.map(t => <button key={t.id} onClick={() => setEventForm(f=>({...f,type:t.id}))} style={{ background: eventForm.type===t.id?`${t.color}18`:C.surface, border: `1px solid ${eventForm.type===t.id?`${t.color}35`:C.border}`, color: eventForm.type===t.id?t.color:C.dim, borderRadius: 12, padding: "3px 8px", fontSize: 9, cursor: "pointer" }}>{t.label}</button>)}</div><button onClick={postEvent} disabled={!eventForm.title||!eventForm.type} style={{ width: "100%", padding: 8, background: eventForm.title&&eventForm.type?`linear-gradient(135deg, ${C.gold}, #a0832e)`:C.card, border: "none", borderRadius: 6, color: eventForm.title&&eventForm.type?"#fff":C.dim, fontSize: 12, fontWeight: 700, cursor: eventForm.title&&eventForm.type?"pointer":"default" }}>📅 Post</button></div>}
                    {events.length===0 ? <p style={{ textAlign: "center", color: C.dim, fontSize: 12 }}>No events yet.</p> : events.map(ev => {const et=EVENT_TYPES.find(t=>t.id===ev.type);return <div key={ev.id} style={{ ...cardS, borderLeft: `3px solid ${et?.color||C.gold}` }}><div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{ev.title}</div><div style={{ fontSize: 10, color: et?.color||C.dim }}>{et?.label||ev.type} • {ev.date}</div>{ev.desc && <p style={{ fontSize: 11, color: "#9ca3af", margin: "4px 0" }}>{ev.desc}</p>}<div style={{ display: "flex", gap: 4 }}>{[{t:"going",i:"✋"},{t:"interested",i:"⭐"},{t:"praying",i:"🙏"}].map(r => <button key={r.t} onClick={() => reactEvent(ev.id,r.t)} style={{ flex: 1, padding: "3px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer", textAlign: "center", fontSize: 10, color: C.dim }}>{r.i} {ev.reactions?.[r.t]||0}</button>)}</div></div>})}
                  </>}

                  {/* CHARITY */}
                  {hubTab === "charity" && CHARITY_CAUSES.map(c => {const pct=Math.round((Math.random()*c.goal*0.7)/c.goal*100);return <div key={c.id} style={cardS}><div style={{ display: "flex", gap: 8 }}><div style={{ fontSize: 24, flexShrink: 0 }}>{c.icon}</div><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{c.name}</div><p style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 6px" }}>{c.desc}</p><div style={{ width: "100%", height: 6, background: C.border, borderRadius: 3 }}><div style={{ width: `${pct}%`, height: "100%", background: c.color, borderRadius: 3 }}/></div><div style={{ fontSize: 9, color: C.dim, fontFamily: mono, marginTop: 2 }}>{pct}% of ${c.goal} goal</div></div></div></div>})}

                  {/* MENTORSHIP */}
                  {hubTab === "mentorship" && MENTOR_ROLES.map(r => <div key={r.id} style={{ ...cardS, display: "flex", gap: 8, alignItems: "center" }}><div style={{ fontSize: 24 }}>{r.icon}</div><div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{r.title}</div></div>)}

                  {/* FAMILY */}
                  {hubTab === "family" && <>
                    <button onClick={generateFamily} disabled={isLoading("family")} style={{ width: "100%", padding: 12, background: isLoading("family")?C.card:`linear-gradient(135deg, ${C.blue}, #3366cc)`, border: "none", borderRadius: 8, color: isLoading("family")?C.dim:"#fff", fontSize: 13, fontWeight: 700, cursor: isLoading("family")?"default":"pointer", fontFamily: font, marginBottom: 10 }}>{isLoading("family")?"⏳ Generating...":"🎲 Generate Family Activity Pack"}</button>
                    {familyActivities && <div>{familyActivities.memory_verse && <div style={{ ...cardS, textAlign: "center", background: `${C.gold}06` }}><div style={{ fontSize: 14, fontWeight: 700, color: C.goldL }}>{familyActivities.theme}</div><p style={{ fontSize: 12, color: "#e2e8f0", margin: "4px 0 0", fontStyle: "italic" }}>"{familyActivities.memory_verse.text}" — {familyActivities.memory_verse.ref}</p></div>}{familyActivities.activities?.map((a,i) => {const icons={game:"🎮",craft:"✂️",devotion:"📖",service:"🤝",cooking:"🍳",outdoor:"🌳"};return <div key={i} style={cardS}><div style={{ display: "flex", gap: 6 }}><div style={{ fontSize: 20 }}>{icons[a.type]||"⭐"}</div><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{a.title}</div><div style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{a.type} • {a.ages} • {a.duration}</div><p style={{ fontSize: 12, color: "#cbd5e1", margin: "4px 0", lineHeight: 1.5 }}>{a.description}</p><p style={{ fontSize: 10, color: C.gold, margin: 0, fontStyle: "italic" }}>✝ {a.faith_connection}</p></div></div></div>})}<AIDisclaimer type="family" /></div>}
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
                <div style={{ ...cardS, padding: 14 }}><p style={{ fontSize: 14, color: "#e2e8f0", margin: 0, lineHeight: 1.8, whiteSpace: "pre-line" }}>{viewSermon.body}</p></div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  {[{t:"love",i:"❤️",c:"#f87171"},{t:"pray",i:"🙏",c:"#a78bfa"},{t:"amen",i:"🙌",c:C.gold}].map(r => <button key={r.t} onClick={() => reactToSermon(viewSermon.id,r.t)} aria-label={r.t} style={{ flex: 1, padding: "7px 4px", background: `${r.c}08`, border: `1px solid ${r.c}25`, borderRadius: 8, cursor: "pointer", textAlign: "center" }}><div style={{ fontSize: 16 }}>{r.i}</div><div style={{ fontSize: 14, fontWeight: 700, color: r.c, fontFamily: mono }}>{viewSermon.reactions?.[r.t]||0}</div></button>)}
                </div>
                <button onClick={() => addToDoc("sermon-shared",viewSermon.title,`${viewSermon.title} — ${viewSermon.author}\n\n${viewSermon.body}`)} style={{ width: "100%", padding: 7, background: `${C.green}10`, border: `1px solid ${C.green}25`, borderRadius: 6, color: C.green, fontSize: 10, fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>📄 Save to Doc</button>
                <div style={{ fontSize: 9, color: C.dim, fontFamily: mono, marginBottom: 4 }}>COMMENTS ({viewSermon.comments?.length||0})</div>
                {(viewSermon.comments||[]).map(c => <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: 7, marginBottom: 3 }}><span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>{c.author}</span><p style={{ fontSize: 11, color: "#cbd5e1", margin: "2px 0 0" }}>{c.text}</p></div>)}
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
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", margin: "0 0 6px", lineHeight: 1.3 }}>{briefing.inspiring.headline}</h3>
                <p style={{ fontSize: 13, color: "#cbd5e1", margin: "0 0 8px", lineHeight: 1.7 }}>{briefing.inspiring.summary}</p>
                {briefing.inspiring.source && <p style={{ fontSize: 9, color: C.dim, fontFamily: mono, margin: "0 0 8px" }}>— {briefing.inspiring.source}</p>}
                <div style={{ background: `${C.miracle}10`, borderRadius: 8, padding: "8px 10px" }}>
                  <span style={{ fontSize: 9, color: C.miracle, fontFamily: mono, fontWeight: 700 }}>🙏 PRAYER</span>
                  <p style={{ fontSize: 12, color: "#86efac", margin: "3px 0 0", fontStyle: "italic", lineHeight: 1.5 }}>{briefing.inspiring.prayer}</p>
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
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
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
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
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
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", margin: "2px 0 4px", lineHeight: 1.3 }}>{item.headline}</h4>
                    <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 6px", lineHeight: 1.5 }}>{item.summary}</p>
                    <p style={{ fontSize: 11, color: C.purple, margin: 0, fontStyle: "italic" }}>🙏 {item.prayer}</p>
                  </div>
                ))}
              </>
            )}

            {/* Verse of Encouragement */}
            {briefing.verse_of_encouragement && (
              <div style={{ background: `${C.gold}06`, border: `1px solid ${C.gold}20`, borderRadius: 10, padding: 14, margin: "12px 0", textAlign: "center" }}>
                <p style={{ fontSize: 14, color: "#e2e8f0", margin: "0 0 4px", fontStyle: "italic", lineHeight: 1.6 }}>"{briefing.verse_of_encouragement.text}"</p>
                <span style={{ fontSize: 10, color: C.gold, fontFamily: mono }}>— {briefing.verse_of_encouragement.ref}</span>
              </div>
            )}

            {/* Closing Briefing Prayer */}
            {briefing.closing_prayer && (
              <div style={{ background: `${C.purple}08`, border: `1px solid ${C.purple}25`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                <div style={{ fontSize: 9, fontFamily: mono, color: C.purple, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>🙏 Prayer for Today's World</div>
                <p style={{ fontSize: 13, color: "#cbd5e1", margin: 0, fontStyle: "italic", lineHeight: 1.7 }}>{briefing.closing_prayer}</p>
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
            <p style={{ fontSize: 14, color: "#e2e8f0", margin: "0 0 16px", lineHeight: 1.8, fontStyle: "italic" }}>{getSessionPrayer()}</p>
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
            { id: "community", icon: "🕊️", label: t.shared },
            { id: "document", icon: "📄", label: `${t.doc}${docBlocks.length?` (${docBlocks.length})`:""}`},
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
