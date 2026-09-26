// admin.js end to end: the token it prints works against the Worker, and it never lands on disk.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/worker.js';

const ADMIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin.js');

function admin(file, ...args) {
  return execFileSync(process.execPath, [ADMIN, ...args], { env: { ...process.env, CLIENTS_FILE: file }, encoding: 'utf8' });
}

async function ask(file, token) {
  const m = new Map([['clients', fs.readFileSync(file, 'utf8')]]);
  const env = { QUOTE_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => m.set(k, v) }, AI_KEY: 'k', GLOBAL_DAILY_LIMIT: '1000' };
  const fakeFetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
  const res = await handle(new Request('https://proxy.test/', { method: 'POST', headers: { 'x-client-token': token }, body: '{"prompt":"hi"}' }), env, fakeFetch);
  return res.status;
}

test('add prints a working token, stores only its hash; pause and resume switch it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-')), 'clients.json');
  const token = admin(file, 'add', 'Acme Freight', '50', '2099-01-01').trim().split('\n').pop();
  assert.match(token, /^qa_[A-Za-z0-9_-]{32}$/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'raw token must not be stored');
  assert.strictEqual(await ask(file, token), 200);

  admin(file, 'pause', 'Acme Freight');
  assert.strictEqual(await ask(file, token), 403);
  admin(file, 'resume', 'Acme Freight');
  assert.strictEqual(await ask(file, token), 200);

  admin(file, 'until', 'Acme Freight', '2020-01-01');
  assert.strictEqual(await ask(file, token), 402);

  const list = admin(file, 'list');
  assert.match(list, /Acme Freight {2}\| {2}enabled {2}\| {2}paid until 2020-01-01 {2}\| {2}50\/day/);
  assert.ok(!list.includes(token));
});

test('unknown client name fails with a non-zero exit', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-')), 'clients.json');
  assert.throws(() => admin(file, 'pause', 'Nobody'), /no client named Nobody/);
});
