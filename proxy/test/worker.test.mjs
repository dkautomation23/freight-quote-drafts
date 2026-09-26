// quote-proxy tests: a Map stands in for KV, a fake fetch for the AI provider. No network.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { handle, PAUSED } from '../src/worker.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function kv(clients) {
  const m = new Map([['clients', JSON.stringify(clients)]]);
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}

function setup({ clients, env = {}, provider } = {}) {
  const base = {
    [hash('tok-a')]: { name: 'Acme', paid_until: '2026-10-26', daily_limit: 200, enabled: true },
    [hash('tok-b')]: { name: 'Beta', paid_until: '2026-10-26', daily_limit: 200, enabled: true }
  };
  const store = kv(clients || base);
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (provider) return provider(url, opts);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"is_quote_request": false, "lanes": []}' }] } }] }), { status: 200 });
  };
  const e = { QUOTE_KV: store, AI_KEY: 'test-ai-key', PROVIDER: 'gemini', GLOBAL_DAILY_LIMIT: '1000', ...env };
  const send = (token, body = { prompt: 'Rate for Dallas TX to Atlanta GA' }, now = NOW) =>
    handle(new Request('https://proxy.test/', {
      method: 'POST', headers: token ? { 'x-client-token': token } : {}, body: JSON.stringify(body)
    }), e, fakeFetch, now);
  return { send, calls, store };
}

test('valid token: provider called with the secret key, answer returned, day counted', async () => {
  const { send, calls, store } = setup();
  const res = await send('tok-a');
  assert.strictEqual(res.status, 200);
  assert.match((await res.json()).text, /is_quote_request/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.headers['x-goog-api-key'], 'test-ai-key');
  assert.strictEqual(store.m.get('n:all:2026-09-26'), '1');
});

test('missing or unknown token: 401, provider never called', async () => {
  const { send, calls } = setup();
  assert.strictEqual((await send(null)).status, 401);
  assert.strictEqual((await send('tok-wrong')).status, 401);
  assert.strictEqual(calls.length, 0);
});

test('paused client: 403 with the pause message', async () => {
  const { send, calls } = setup({ clients: { [hash('tok-a')]: { name: 'Acme', paid_until: '2026-10-26', daily_limit: 200, enabled: false } } });
  const res = await send('tok-a');
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).error, PAUSED);
  assert.strictEqual(calls.length, 0);
});

test('paid_until in the past: 402; paid through today: allowed', async () => {
  const clients = {
    [hash('tok-old')]: { name: 'Old', paid_until: '2026-09-25', daily_limit: 200, enabled: true },
    [hash('tok-today')]: { name: 'Today', paid_until: '2026-09-26', daily_limit: 200, enabled: true }
  };
  const { send, calls } = setup({ clients });
  const res = await send('tok-old');
  assert.strictEqual(res.status, 402);
  assert.strictEqual((await res.json()).error, PAUSED);
  assert.strictEqual((await send('tok-today')).status, 200);
  assert.strictEqual(calls.length, 1);
});

test('daily limit per client: the next request is refused, the next day works again', async () => {
  const { send, calls } = setup({ clients: { [hash('tok-a')]: { name: 'Acme', paid_until: '2026-10-26', daily_limit: 2, enabled: true } } });
  assert.strictEqual((await send('tok-a')).status, 200);
  assert.strictEqual((await send('tok-a')).status, 200);
  const third = await send('tok-a');
  assert.strictEqual(third.status, 429);
  assert.strictEqual((await third.json()).error, PAUSED);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual((await send('tok-a', undefined, new Date('2026-09-27T01:00:00Z'))).status, 200);
});

test('global ceiling across all clients: 503 once the day is used up', async () => {
  const { send, calls } = setup({ env: { GLOBAL_DAILY_LIMIT: '3' } });
  for (const t of ['tok-a', 'tok-b', 'tok-a']) assert.strictEqual((await send(t)).status, 200);
  const res = await send('tok-b');
  assert.strictEqual(res.status, 503);
  assert.strictEqual((await res.json()).reason, 'global limit');
  assert.strictEqual(calls.length, 3);
});

test('provider down: 502 with the status only', async () => {
  const { send } = setup({ provider: async () => new Response('overloaded', { status: 503 }) });
  const res = await send('tok-a');
  assert.strictEqual(res.status, 502);
  assert.deepStrictEqual(await res.json(), { error: 'ai http 503' });
});

test('anthropic provider: Messages API call with claude-haiku-4-5', async () => {
  const { send, calls } = setup({
    env: { PROVIDER: 'anthropic', MODEL: 'claude-haiku-4-5' },
    provider: async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"is_quote_request": true, "lanes": []}' }] }), { status: 200 })
  });
  const res = await send('tok-a');
  assert.strictEqual(res.status, 200);
  assert.match((await res.json()).text, /"is_quote_request": true/);
  assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(calls[0].opts.headers['x-api-key'], 'test-ai-key');
  assert.strictEqual(calls[0].opts.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(JSON.parse(calls[0].opts.body).model, 'claude-haiku-4-5');
});

test('bad requests: GET, empty body, oversized prompt', async () => {
  const { send, calls } = setup();
  const e = { QUOTE_KV: kv({}), AI_KEY: 'k' };
  assert.strictEqual((await handle(new Request('https://proxy.test/'), e, async () => {}, NOW)).status, 405);
  assert.strictEqual((await send('tok-a', {})).status, 400);
  assert.strictEqual((await send('tok-a', { prompt: 'x'.repeat(20001) })).status, 413);
  assert.strictEqual(calls.length, 0);
});

test('email text and the AI key never reach logs, KV or error replies', async () => {
  const MARK = 'SECRET-LOAD-7731 Dallas';
  const captured = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = console[level];
    console[level] = (...a) => captured.push(a.map(String).join(' '));
  }
  try {
    const ok = setup();
    const down = setup({ provider: async () => new Response('boom ' + MARK, { status: 500 }) });
    const replies = [
      await ok.send('tok-a', { prompt: MARK }),
      await down.send('tok-a', { prompt: MARK }),
      await ok.send('tok-wrong', { prompt: MARK })
    ];
    const bodies = await Promise.all(replies.map((r) => r.text()));
    const stored = [...ok.store.m.values(), ...down.store.m.values()].join('\n');
    for (const where of [captured.join('\n'), stored, bodies.join('\n')]) {
      assert.ok(!where.includes('SECRET-LOAD-7731'), 'email text leaked');
      assert.ok(!where.includes('test-ai-key'), 'AI key leaked');
    }
  } finally {
    Object.assign(console, saved);
  }
});
