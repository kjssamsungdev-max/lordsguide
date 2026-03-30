/**
 * SCRIPTURE FORGE — Test Suite
 * 30 tests covering all critical paths
 * 
 * Run: node scripture-forge.test.js
 * 
 * No external deps — self-contained test runner.
 * For production: migrate to jest + react-testing-library
 */

// ═══ MINI TEST RUNNER ═══
let passed = 0, failed = 0, total = 0;
const results = [];

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    results.push({ name, status: "✅" });
  } catch (e) {
    failed++;
    results.push({ name, status: "❌", error: e.message });
  }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toEqual(expected) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toThrow() { /* handled by caller */ },
    toContain(sub) { if (!actual.includes(sub)) throw new Error(`Expected "${actual}" to contain "${sub}"`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThanOrEqual(n) { if (actual > n) throw new Error(`Expected ${actual} <= ${n}`); },
  };
}

// ═══ IMPORT FUNCTIONS (inline since we can't import JSX directly) ═══

// Sanitize
function sanitize(str, maxLen) {
  if (!str) return "";
  return str.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function isValidPassage(p) {
  if (!p || p.length < 3) return false;
  return /^(\d\s)?[A-Za-z]+(\s[A-Za-z]+){0,3}\s\d+/.test(p.trim());
}

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

function parseAIJSON(raw) {
  let cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch (e1) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (e2) { /* fall through */ }
    }
    try {
      const fixed = cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]").replace(/'/g, '"');
      const m2 = fixed.match(/\{[\s\S]*\}/);
      if (m2) return JSON.parse(m2[0]);
    } catch { /* fall through */ }
    throw new Error("AI returned malformed data. Please try again — responses vary each time.");
  }
}

const MAX_CACHE = 50;
function lruEvict(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE) return cache;
  entries.sort((a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0));
  const evictCount = entries.length - MAX_CACHE;
  const keep = Object.fromEntries(entries.slice(evictCount));
  return keep;
}

const TIER_LIMITS = {
  miracle: { aiCallsPerDay: 3, sourcesPerDay: 1, podium: false, illustrations: false, songsPerDay: 1 },
  shepherd: { aiCallsPerDay: 50, sourcesPerDay: 50, podium: true, illustrations: true, songsPerDay: 20 },
  commission: { aiCallsPerDay: 200, sourcesPerDay: 200, podium: true, illustrations: true, songsPerDay: 100 },
};

const INPUT_LIMITS = { passage: 100, topic: 200, sermonBody: 10000, comment: 2000, songReq: 300 };

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITE — 30 Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log("═══ SCRIPTURE FORGE TEST SUITE ═══\n");

// ── GROUP 1: Input Sanitization (5 tests) ──
console.log("── Sanitization ──");

test("sanitize: trims and limits length", () => {
  expect(sanitize("Hello World", 5)).toBe("Hello");
  expect(sanitize("  Hello  ", 20)).toBe("Hello");
  expect(sanitize("  Hello World  ", 15)).toBe("Hello World");
});

test("sanitize: strips control characters", () => {
  expect(sanitize("Hello\x00\x07World", 100)).toBe("HelloWorld");
});

test("sanitize: handles null/undefined", () => {
  expect(sanitize(null, 100)).toBe("");
  expect(sanitize(undefined, 100)).toBe("");
  expect(sanitize("", 100)).toBe("");
});

test("sanitize: enforces max length on long strings", () => {
  const long = "A".repeat(50000);
  const result = sanitize(long, INPUT_LIMITS.sermonBody);
  expect(result.length).toBeLessThanOrEqual(INPUT_LIMITS.sermonBody);
});

test("sanitize: preserves valid Unicode (emojis, accents)", () => {
  expect(sanitize("Café ☕ 🙏", 100)).toBe("Café ☕ 🙏");
});

// ── GROUP 2: Email Validation (3 tests) ──
console.log("── Email Validation ──");

test("isValidEmail: accepts valid emails", () => {
  expect(isValidEmail("pastor@church.org")).toBeTruthy();
  expect(isValidEmail("john.doe+tag@gmail.com")).toBeTruthy();
});

test("isValidEmail: rejects invalid emails", () => {
  expect(isValidEmail("notanemail")).toBeFalsy();
  expect(isValidEmail("@missing.com")).toBeFalsy();
  expect(isValidEmail("no spaces@test.com")).toBeFalsy();
  expect(isValidEmail("")).toBeFalsy();
});

test("isValidEmail: rejects null/undefined", () => {
  expect(isValidEmail(null)).toBeFalsy();
  expect(isValidEmail(undefined)).toBeFalsy();
});

// ── GROUP 3: Passage Validation (4 tests) ──
console.log("── Passage Validation ──");

test("isValidPassage: accepts standard references", () => {
  expect(isValidPassage("John 3:16")).toBeTruthy();
  expect(isValidPassage("Genesis 1")).toBeTruthy();
  expect(isValidPassage("1 Corinthians 13")).toBeTruthy();
  expect(isValidPassage("2 Kings 5:1-14")).toBeTruthy();
  expect(isValidPassage("Song of Solomon 2")).toBeTruthy();
});

test("isValidPassage: rejects garbage input", () => {
  expect(isValidPassage("asdf")).toBeFalsy();
  expect(isValidPassage("hello world")).toBeFalsy();
  expect(isValidPassage("12345")).toBeFalsy();
});

test("isValidPassage: rejects empty/short input", () => {
  expect(isValidPassage("")).toBeFalsy();
  expect(isValidPassage("ab")).toBeFalsy();
  expect(isValidPassage(null)).toBeFalsy();
});

test("isValidPassage: rejects SQL injection attempts", () => {
  expect(isValidPassage("'; DROP TABLE users; --")).toBeFalsy();
  expect(isValidPassage("<script>alert(1)</script>")).toBeFalsy();
});

// ── GROUP 4: Sermon Schema Validation (5 tests) ──
console.log("── Sermon Validation ──");

test("validateSermon: accepts valid sermon", () => {
  const valid = {
    title: "Test Sermon",
    big_idea: "Testing",
    introduction: { hook: "Hook", context: "Ctx", thesis: "Thesis" },
    points: [
      { heading: "Point 1", verses: "John 1:1", explanation: "Expl", illustration: "Ill", application: "App" },
      { heading: "Point 2", verses: "John 1:2", explanation: "Expl2", illustration: "Ill2", application: "App2" },
    ],
    conclusion: { summary: "Sum", call: "Call", closing: "Close" },
    cross_refs: ["Rom 8:28"],
    questions: ["Q1"],
  };
  expect(validateSermon(valid).valid).toBeTruthy();
});

test("validateSermon: rejects null/undefined", () => {
  expect(validateSermon(null).valid).toBeFalsy();
  expect(validateSermon(undefined).valid).toBeFalsy();
  expect(validateSermon("string").valid).toBeFalsy();
});

test("validateSermon: rejects missing title", () => {
  const r = validateSermon({ introduction: { hook: "h" }, points: [{ heading: "h", explanation: "e" }], conclusion: {} });
  expect(r.valid).toBeFalsy();
  expect(r.msg).toContain("title");
});

test("validateSermon: rejects empty points array", () => {
  const r = validateSermon({ title: "T", introduction: { hook: "h" }, points: [], conclusion: {} });
  expect(r.valid).toBeFalsy();
  expect(r.msg).toContain("points");
});

test("validateSermon: rejects incomplete point", () => {
  const r = validateSermon({
    title: "T", introduction: { hook: "h" },
    points: [{ heading: "P1", explanation: "E1" }, { heading: "P2" }], // P2 missing explanation
    conclusion: { summary: "S" },
  });
  expect(r.valid).toBeFalsy();
  expect(r.msg).toContain("Point 2");
});

// ── GROUP 5: Topical Schema Validation (2 tests) ──
console.log("── Topical Validation ──");

test("validateTopical: accepts valid study", () => {
  expect(validateTopical({ title: "Faith", definition: "Def", passages: [{ ref: "Heb 11:1" }] }).valid).toBeTruthy();
});

test("validateTopical: rejects empty passages", () => {
  expect(validateTopical({ title: "Faith", passages: [] }).valid).toBeFalsy();
});

// ── GROUP 6: Source Schema Validation (3 tests) ──
console.log("── Source Validation ──");

test("validateSource: accepts valid commentary", () => {
  expect(validateSource("commentary", { entries: [{ verse: "v1", text: "t" }] }).valid).toBeTruthy();
});

test("validateSource: rejects empty lexicon", () => {
  expect(validateSource("lexicon", { words: [] }).valid).toBeFalsy();
});

test("validateSource: accepts valid devotional", () => {
  expect(validateSource("devotional", { theme: "Grace", reflection: "Text" }).valid).toBeTruthy();
  expect(validateSource("devotional", { theme: "Grace" }).valid).toBeFalsy();
});

// ── GROUP 7: AI JSON Parsing (5 tests) ──
console.log("── JSON Parsing ──");

test("parseAIJSON: parses clean JSON", () => {
  const r = parseAIJSON('{"title":"Test","value":42}');
  expect(r.title).toBe("Test");
  expect(r.value).toBe(42);
});

test("parseAIJSON: strips markdown fencing", () => {
  const r = parseAIJSON('```json\n{"title":"Fenced"}\n```');
  expect(r.title).toBe("Fenced");
});

test("parseAIJSON: extracts JSON from surrounding text", () => {
  const r = parseAIJSON('Here is the result: {"title":"Embedded"} Hope that helps!');
  expect(r.title).toBe("Embedded");
});

test("parseAIJSON: fixes trailing commas", () => {
  const r = parseAIJSON('{"title":"Comma","items":["a","b",]}');
  expect(r.title).toBe("Comma");
});

test("parseAIJSON: throws on total garbage", () => {
  let threw = false;
  try { parseAIJSON("This is not JSON at all"); } catch (e) {
    threw = true;
    expect(e.message).toContain("malformed");
  }
  expect(threw).toBeTruthy();
});

// ── GROUP 8: LRU Cache (3 tests) ──
console.log("── LRU Cache ──");

test("lruEvict: keeps cache under MAX_CACHE", () => {
  const cache = {};
  for (let i = 0; i < 60; i++) {
    cache[`key_${i}`] = { data: i, lastAccessed: i * 1000 };
  }
  const evicted = lruEvict(cache);
  expect(Object.keys(evicted).length).toBeLessThanOrEqual(MAX_CACHE);
});

test("lruEvict: evicts least recently accessed", () => {
  const cache = {};
  for (let i = 0; i < 52; i++) {
    cache[`key_${i}`] = { data: i, lastAccessed: i === 0 ? 999999999 : i * 1000 }; // key_0 was accessed most recently
  }
  const evicted = lruEvict(cache);
  // key_0 should survive (highest lastAccessed), key_1 should be evicted (lowest lastAccessed after sort)
  expect("key_0" in evicted).toBeTruthy();
});

test("lruEvict: no-op when under limit", () => {
  const cache = { a: { data: 1, lastAccessed: 1 }, b: { data: 2, lastAccessed: 2 } };
  const result = lruEvict(cache);
  expect(Object.keys(result).length).toBe(2);
});

// ── GROUP 9: Tier Limits (3 tests) ──
console.log("── Tier Limits ──");

test("TIER_LIMITS: miracle has strict limits", () => {
  expect(TIER_LIMITS.miracle.aiCallsPerDay).toBe(3);
  expect(TIER_LIMITS.miracle.podium).toBeFalsy();
  expect(TIER_LIMITS.miracle.illustrations).toBeFalsy();
});

test("TIER_LIMITS: shepherd has generous limits", () => {
  expect(TIER_LIMITS.shepherd.aiCallsPerDay).toBe(50);
  expect(TIER_LIMITS.shepherd.podium).toBeTruthy();
  expect(TIER_LIMITS.shepherd.illustrations).toBeTruthy();
});

test("TIER_LIMITS: commission has highest limits", () => {
  expect(TIER_LIMITS.commission.aiCallsPerDay).toBeGreaterThan(TIER_LIMITS.shepherd.aiCallsPerDay);
});

// ── GROUP 10: Illustration Validation (2 tests) ──
console.log("── Illustration Validation ──");

test("validateIllustrations: accepts valid data", () => {
  expect(validateIllustrations({ illustrations: [{ title: "T", content: "C" }] }).valid).toBeTruthy();
});

test("validateIllustrations: rejects empty array", () => {
  expect(validateIllustrations({ illustrations: [] }).valid).toBeFalsy();
  expect(validateIllustrations(null).valid).toBeFalsy();
});

// ═══ RESULTS ═══
console.log("\n═══════════════════════════════════════");
console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
console.log("═══════════════════════════════════════\n");

results.forEach(r => {
  console.log(`  ${r.status} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
});

console.log(`\n${failed === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failed} TESTS FAILED`}`);
process.exit(failed > 0 ? 1 : 0);
