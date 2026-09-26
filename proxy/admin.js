#!/usr/bin/env node
// Client list for quote-proxy. Edits a local JSON file; `push` prints the command that uploads it to KV.
//   node proxy/admin.js add <name> [daily_limit=200] [paid_until=YYYY-MM-DD, default +30 days]
//   node proxy/admin.js pause|resume <name>
//   node proxy/admin.js limit <name> <n>
//   node proxy/admin.js until <name> <YYYY-MM-DD>
//   node proxy/admin.js list
//   node proxy/admin.js push
// The token is printed once by `add` and never stored: the file keeps only its SHA-256.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.CLIENTS_FILE || path.join(__dirname, 'clients.local.json');
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {});
const save = (clients) => fs.writeFileSync(FILE, JSON.stringify(clients, null, 2) + '\n');
const fail = (msg) => { console.error(msg); process.exit(1); };

function byName(clients, name) {
  const id = Object.keys(clients).find((k) => clients[k].name === name);
  if (!id) fail('no client named ' + name);
  return clients[id];
}

const [cmd, name, arg, arg2] = process.argv.slice(2);
const clients = load();

switch (cmd) {
  case 'add': {
    if (!name) fail('usage: add <name> [daily_limit] [paid_until]');
    if (Object.values(clients).some((c) => c.name === name)) fail('client exists: ' + name);
    const limit = Number(arg || 200);
    const until = arg2 || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    if (!(limit > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail('bad limit or date');
    const token = 'qa_' + crypto.randomBytes(24).toString('base64url');
    const id = crypto.createHash('sha256').update(token).digest('hex');
    clients[id] = { name, paid_until: until, daily_limit: limit, enabled: true };
    save(clients);
    console.log('client token (shown once, put it in the client sheet Settings > Client token):');
    console.log(token);
    break;
  }
  case 'pause':
  case 'resume':
    byName(clients, name).enabled = cmd === 'resume';
    save(clients);
    console.log(name + ': ' + (cmd === 'resume' ? 'enabled' : 'paused'));
    break;
  case 'limit':
    if (!(Number(arg) > 0)) fail('usage: limit <name> <n>');
    byName(clients, name).daily_limit = Number(arg);
    save(clients);
    console.log(name + ': daily_limit ' + arg);
    break;
  case 'until':
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg || '')) fail('usage: until <name> <YYYY-MM-DD>');
    byName(clients, name).paid_until = arg;
    save(clients);
    console.log(name + ': paid_until ' + arg);
    break;
  case 'list':
    for (const c of Object.values(clients)) {
      console.log([c.name, c.enabled ? 'enabled' : 'PAUSED', 'paid until ' + c.paid_until, c.daily_limit + '/day'].join('  |  '));
    }
    break;
  case 'push':
    console.log('Run from proxy/ to upload the list (needs a deployed Worker and KV namespace):');
    console.log('npx wrangler kv key put --binding=QUOTE_KV clients --path clients.local.json --remote');
    break;
  default:
    fail('commands: add, pause, resume, limit, until, list, push');
}
