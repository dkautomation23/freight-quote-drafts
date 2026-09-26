// Sends each demo email through the real prompt to Gemini, saves the raw answer to
// test/recorded/<id>.json and compares the reading with test/expected.js.
// Usage: GEMINI_API_KEY=... node scripts/live-eval.js [model]   (exit code 1 on any mismatch)
const fs = require('node:fs');
const path = require('node:path');
const { loadGas } = require('../test/gas.js');
const expected = require('../test/expected.js');

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('Set GEMINI_API_KEY'); process.exit(2); }
const model = process.argv[2] || 'gemini-flash-latest';
const gas = loadGas();
const rows = gas.rateRowsFromTable(gas.DEMO_RATES);
const seenVersions = new Set();

async function callModel(prompt) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    if ((res.status === 429 || res.status === 503) && attempt < 5) { await new Promise((r) => setTimeout(r, 20000)); continue; }
    if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.modelVersion) seenVersions.add(data.modelVersion);
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
}

function compare(id, text) {
  const exp = expected[id];
  const problems = [];
  const plan = gas.planReply(gas.DEMO_EMAILS.find((e) => e.id === id).messages, text, rows, {});
  if ((plan.action === 'draft') !== exp.quote) return [`quote=${plan.action === 'draft'}, expected ${exp.quote}`];
  if (!exp.quote) return problems;
  if (plan.items.length !== exp.lanes.length) return [`${plan.items.length} lanes, expected ${exp.lanes.length}`];
  plan.items.forEach(({ lane, quote }, i) => {
    const e = exp.lanes[i];
    const got = {
      o: lane.origin && `${lane.origin.city}, ${lane.origin.state}`,
      d: lane.destination && `${lane.destination.city}, ${lane.destination.state}`,
      eq: lane.equipment, w: lane.weight_lbs, date: lane.pickup_date,
      missing: lane.missing.join(','), rate: quote.kind === 'exact' ? quote.rate : quote.kind
    };
    for (const k of Object.keys(got)) {
      const want = k === 'missing' ? e.missing.join(',') : e[k];
      if (got[k] !== want) problems.push(`lane ${i + 1} ${k}: got ${JSON.stringify(got[k])}, expected ${JSON.stringify(want)}`);
    }
  });
  return problems;
}

(async () => {
  let failed = 0;
  for (const email of gas.DEMO_EMAILS) {
    let problems;
    try {
      const text = await callModel(gas.buildPrompt(email.messages));
      fs.writeFileSync(path.join(__dirname, '..', 'test', 'recorded', email.id + '.json'), text.trim() + '\n');
      problems = compare(email.id, text);
    } catch (e) {
      problems = [String(e.message).split('\n')[0]]; // e.g. the free tier's 20 requests/day per model
    }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${email.id}${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);
    if (problems.length) failed++;
    await new Promise((r) => setTimeout(r, 7000));
  }
  console.log(`\n${gas.DEMO_EMAILS.length - failed}/${gas.DEMO_EMAILS.length} match (model ${model} -> ${[...seenVersions].join(', ') || 'version not reported'}, ${new Date().toISOString().slice(0, 10)})`);
  process.exit(failed ? 1 : 0);
})();
