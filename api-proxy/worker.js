// ═══════════════════════════════════════════════════════════════════════════
// LORDSGUIDE — Cloudflare Worker API Proxy
// Keeps ANTHROPIC_API_KEY server-side. Never exposed to client.
//
// Deploy: cd api-proxy && npx wrangler deploy
// Set secret: npx wrangler secret put ANTHROPIC_API_KEY
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://lordsguide.com',
  'https://www.lordsguide.com',
  'https://lordsguide.pages.dev',
  'http://localhost:3000',
  'http://localhost:5173',
];

const RATE_LIMIT_MAP = new Map();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT_MAP.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

function corsHeaders(origin) {
  if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.lordsguide.pages.dev'))) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
  }
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only POST allowed
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Validate API key exists
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();

      // Only allow specific models
      const allowedModels = ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'];
      if (!allowedModels.includes(body.model)) {
        return new Response(JSON.stringify({ error: 'Invalid model' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // Cap max_tokens
      body.max_tokens = Math.min(body.max_tokens || 4000, 4096);

      // Forward to Anthropic
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await anthropicResponse.json();

      return new Response(JSON.stringify(data), {
        status: anthropicResponse.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
