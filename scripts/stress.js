// Stress test: 40 broker-inbox emails written by a separate author with the expected reading
// (test/stress/emails.json), sent through the live quote-proxy with the same prompt the script uses.
// Raw answers go to test/stress/answers.json, the scores to docs/stress-report.md.
// Usage: node scripts/stress.js <client-token-file> [only-id ...]   (exit code 1 below 90% whole-email)
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../test/gas.js');
const { formatLocal } = require('../test/tz.js');

const ROOT = path.join(__dirname, '..');
const URL = 'https://quote-proxy.dkautomation.workers.dev/';
const TZ = 'America/Chicago';
const token = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\s+/).pop(); // the file may carry a note above the token
const only = process.argv.slice(3);
const gas = loadGas();
const emails = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/stress/emails.json'), 'utf8'))
  .filter((e) => !only.length || only.some((id) => e.id.startsWith(id)));
const FIELDS = ['quote', 'lanes', 'o', 'd', 'eq', 'w', 'date'];

async function ask(prompt) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-token': token }, body: JSON.stringify({ prompt }) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 502 && attempt < 3) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (res.status !== 200) throw new Error(`proxy ${res.status}: ${body.error || ''} ${body.reason || ''}`);
    return body.text;
  }
}

// Field by field against the hand-written answer. Lane fields are compared only when the lane count matches.
function score(email, text) {
  const exp = email.expected;
  const miss = [];
  let plan;
  try { plan = gas.planReply(email.messages, text, [], {}); } catch (e) { return { miss: ['parse: ' + e.message], checked: { quote: false } }; }
  const checked = { quote: (plan.action === 'draft') === exp.quote };
  if (!checked.quote) return { miss: [`quote=${plan.action === 'draft'}`], checked };
  if (!exp.quote) return { miss, checked };
  checked.lanes = plan.items.length === exp.lanes.length;
  if (!checked.lanes) return { miss: [`${plan.items.length} lanes, expected ${exp.lanes.length}`], checked };
  const place = (p) => p && `${p.city}, ${p.state}`;
  for (const f of ['o', 'd', 'eq', 'w', 'date']) checked[f] = true;
  plan.items.forEach(({ lane }, i) => {
    const got = { o: place(lane.origin), d: place(lane.destination), eq: lane.equipment, w: lane.weight_lbs, date: lane.pickup_date };
    for (const f of Object.keys(got)) {
      if (got[f] !== exp.lanes[i][f]) { checked[f] = false; miss.push(`lane ${i + 1} ${f}: got ${JSON.stringify(got[f])}, expected ${JSON.stringify(exp.lanes[i][f])}`); }
    }
  });
  return { miss, checked };
}

(async () => {
  const answersFile = path.join(ROOT, 'test/stress/answers.json');
  const answers = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf8')) : {};
  const rows = [];
  for (const email of emails) {
    const messages = email.messages.map((m) => ({ ...m, local: formatLocal(new Date(m.date), TZ) }));
    let text;
    try {
      text = await ask(gas.buildPrompt(messages, email.subject));
      answers[email.id] = text.trim();
    } catch (e) {
      console.log(`ERR  ${email.id} ${e.message}`);
      rows.push({ email, miss: [e.message], checked: {} });
      continue;
    }
    const r = score({ ...email, messages }, text);
    rows.push({ email, ...r });
    console.log(`${r.miss.length ? 'FAIL' : 'ok  '} ${email.id}${r.miss.length ? '\n     ' + r.miss.join('\n     ') : ''}`);
  }
  fs.writeFileSync(answersFile, JSON.stringify(answers, null, 2) + '\n');
  if (only.length) return;

  const ok = rows.filter((r) => !r.miss.length).length;
  const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
  const perField = FIELDS.map((f) => {
    const seen = rows.filter((r) => f in r.checked);
    return `| ${f} | ${seen.filter((r) => r.checked[f]).length}/${seen.length} | ${pct(seen.filter((r) => r.checked[f]).length, seen.length)} |`;
  });
  const cats = {};
  rows.forEach((r) => { const c = (cats[r.email.category] = cats[r.email.category] || [0, 0]); c[1]++; if (!r.miss.length) c[0]++; });
  const report = [
    '# Stress test: 40 broker-inbox emails through the live proxy',
    '',
    `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, model claude-haiku-4-5 via quote-proxy, time zone ${TZ}.`,
    'Emails and expected answers written by a separate agent that never saw the prompt (`test/stress/emails.json`);',
    'raw model answers in `test/stress/answers.json`. Rerun: `node scripts/stress.js <token-file>`.',
    '',
    `**Whole email correct: ${ok}/${rows.length} (${pct(ok, rows.length)})** — every field of every lane, plus quote / not-quote.`,
    '',
    '| Field | Correct | % |', '|---|---|---|', ...perField,
    '',
    'Lane fields are scored only for emails where the lane count matched.',
    '',
    '| Category | Whole email correct |', '|---|---|',
    ...Object.entries(cats).map(([c, [a, b]]) => `| ${c} | ${a}/${b} |`),
    '',
    '## Misses',
    '',
    ...(rows.filter((r) => r.miss.length).map((r) => `- \`${r.email.id}\`: ${r.miss.join('; ')}`)),
    ...(ok === rows.length ? ['None.'] : []),
    ''
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs/stress-report.md'), report);
  console.log(`\n${ok}/${rows.length} whole-email correct (${pct(ok, rows.length)})`);
  process.exit(ok / rows.length > 0.9 ? 0 : 1);
})();
