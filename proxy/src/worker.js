// quote-proxy: the only place the AI key lives. Apps Script sends {prompt} with a client token;
// the Worker checks the token, counts the day's requests and calls the AI provider.
// It never logs or stores email text: KV holds the client list and daily counters only.

export const PAUSED = 'service paused - contact Dmytro';
const MAX_PROMPT_CHARS = 20000;
const DAY_TTL = 2 * 24 * 60 * 60; // counters expire on their own

export default {
  fetch: (request, env) => handle(request, env, fetch)
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// KV stores token hashes, never the tokens themselves (admin.js writes the same hash).
export async function handle(request, env, fetchImpl, now = new Date()) {
  if (request.method !== 'POST') return reply(405, { error: 'POST only' });
  const token = request.headers.get('x-client-token');
  if (!token) return reply(401, { error: 'missing client token' });

  const id = await sha256(token);
  const clients = JSON.parse((await env.QUOTE_KV.get('clients')) || '{}');
  const client = clients[id];
  const today = now.toISOString().slice(0, 10);
  if (!client) return reply(401, { error: 'unknown client token' });
  if (!client.enabled) return reply(403, { error: PAUSED, reason: 'paused' });
  if (!client.paid_until || client.paid_until < today) return reply(402, { error: PAUSED, reason: 'not paid' });

  let prompt;
  try { prompt = (await request.json()).prompt; } catch (e) { prompt = null; }
  if (typeof prompt !== 'string' || !prompt) return reply(400, { error: 'body must be {"prompt": "..."}' });
  if (prompt.length > MAX_PROMPT_CHARS) return reply(413, { error: 'prompt too long' });

  const clientKey = 'n:' + id.slice(0, 16) + ':' + today;
  const allKey = 'n:all:' + today;
  const used = Number(await env.QUOTE_KV.get(clientKey)) || 0;
  const usedAll = Number(await env.QUOTE_KV.get(allKey)) || 0;
  if (usedAll >= globalCeiling(clients, env, today)) return reply(503, { error: PAUSED, reason: 'global limit' });
  if (used >= Number(client.daily_limit || 0)) return reply(429, { error: PAUSED, reason: 'daily limit' });

  // Counted before the call: a request that reaches the provider costs money even if it fails.
  await env.QUOTE_KV.put(clientKey, String(used + 1), { expirationTtl: DAY_TTL });
  await env.QUOTE_KV.put(allKey, String(usedAll + 1), { expirationTtl: DAY_TTL });

  try {
    return reply(200, { text: await callProvider(env, prompt, fetchImpl) });
  } catch (e) {
    return reply(502, { error: String(e.message).slice(0, 200) }); // provider status only, never the prompt
  }
}

// All clients together: their own limits plus 10% (KV counters are not atomic, parallel requests can
// slip past a client limit), never above GLOBAL_DAILY_LIMIT. Paused and unpaid clients add nothing.
export function globalCeiling(clients, env, today) {
  const sum = Object.values(clients)
    .filter((c) => c.enabled && c.paid_until && c.paid_until >= today)
    .reduce((n, c) => n + Number(c.daily_limit || 0), 0);
  return Math.min(Math.ceil(sum * 11 / 10), Number(env.GLOBAL_DAILY_LIMIT || 1000));
}

// One switch for the provider: PROVIDER = "gemini" (free, for tests) or "anthropic".
async function callProvider(env, prompt, fetchImpl) {
  if (env.PROVIDER === 'anthropic') {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error('ai http ' + res.status);
    const data = await res.json();
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  const model = env.MODEL || 'gemini-flash-latest';
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.AI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) throw new Error('ai http ' + res.status);
  const data = await res.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}
