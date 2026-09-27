// Parsing and reply tests on the 10 demo emails, using Gemini answers recorded by scripts/live-eval.js.
const test = require('node:test');
const assert = require('node:assert');
const { loadGas, recorded } = require('./gas.js');
const expected = require('./expected.js');

const gas = loadGas();
const rows = gas.rateRowsFromTable(gas.DEMO_RATES);
const settings = { signerName: 'Sam Reyes', companyName: 'Northline Freight (demo)' };
const place = (p) => p && `${p.city}, ${p.state}`;

for (const email of gas.DEMO_EMAILS) {
  test(`fixture ${email.id}`, () => {
    const exp = expected[email.id];
    const plan = gas.planReply(email.messages, recorded(email.id), rows, settings);
    assert.strictEqual(plan.action, exp.quote ? 'draft' : 'skip');
    if (!exp.quote) return;

    assert.strictEqual(plan.items.length, exp.lanes.length);
    plan.items.forEach(({ lane, quote }, i) => {
      const e = exp.lanes[i];
      assert.strictEqual(place(lane.origin), e.o);
      assert.strictEqual(place(lane.destination), e.d);
      assert.strictEqual(lane.equipment, e.eq);
      assert.strictEqual(lane.weight_lbs, e.w);
      assert.strictEqual(lane.pickup_date, e.date);
      assert.deepStrictEqual([...lane.missing], e.missing);
      assert.strictEqual(quote.kind === 'exact' ? quote.rate : quote.kind, e.rate);
      if (typeof e.rate === 'number') assert.ok(plan.body.includes(gas.money(e.rate) + ' all-in'));
    });

    const asks = exp.lanes.some((l) => l.missing.length);
    assert.strictEqual(plan.body.includes('could you tell me'), asks, 'asks questions only when something is missing');
    assert.match(plan.body, /Sam Reyes\nNorthline Freight \(demo\)$/);
    assert.doesNotMatch(plan.body, /555|undefined|null|NaN/, 'no phone numbers or broken values in the draft');
  });
}

test('no rate history: placeholder the broker must fill, never a made-up number', () => {
  const plan = gas.planReply(gas.DEMO_EMAILS[5].messages, recorded('06-flatbed'), rows, settings);
  assert.match(plan.body, /\[RATE: no history for this lane\]/);
  assert.doesNotMatch(plan.body, /\$1,500/, 'the dry van rate on the same lane must not be used for flatbed');
});

test('similar lanes: range shown only as a note for the broker', () => {
  const plan = gas.planReply(gas.DEMO_EMAILS[4].messages, recorded('05-reefer'), rows, settings);
  assert.match(plan.body, /\[RATE: no loads on this exact lane; similar lanes paid \$2,600-\$2,750\]/);
});

test('missing weight becomes a question, rate still shown', () => {
  const plan = gas.planReply(gas.DEMO_EMAILS[1].messages, recorded('02-no-weight'), rows, settings);
  assert.match(plan.body, /\$1,425 all-in/);
  assert.match(plan.body, /could you tell me:\n- the total weight/);
});

test('two lanes: questions and rates are per lane', () => {
  const plan = gas.planReply(gas.DEMO_EMAILS[3].messages, recorded('04-two-lanes'), rows, settings);
  assert.match(plan.body, /Here are our rates:/);
  assert.match(plan.body, /Atlanta, GA to Charlotte, NC .*\$725 all-in/);
  assert.match(plan.body, /Atlanta, GA to Nashville, TN .*\[RATE: no history/);
});

test('greets by first name, falls back to "there" for a bare address', () => {
  assert.match(gas.planReply(gas.DEMO_EMAILS[0].messages, recorded('01-full'), rows, settings).body, /^Hi Laura,/);
  assert.match(gas.planReply(gas.DEMO_EMAILS[9].messages, recorded('10-typos'), rows, settings).body, /^Hi there,/);
});

test('thread reply answers the customer, not our own message', () => {
  const plan = gas.planReply(gas.DEMO_EMAILS[7].messages, recorded('08-reply-in-thread'), rows, settings);
  assert.match(plan.body, /^Hi Ben,/);
});

test('quoted text and old replies are stripped before the prompt', () => {
  const s = gas.stripQuoted('About 30,000 lbs.\n\nOn Thu, Sep 24, 2026 at 1:40 PM Sam <me@example.com> wrote:\n> old');
  assert.strictEqual(s, 'About 30,000 lbs.');
  assert.strictEqual(gas.stripQuoted('new\n> quoted\nmore'), 'new\nmore');
});

test('prompt carries the send date so "Fri" can be resolved', () => {
  const p = gas.buildPrompt(gas.DEMO_EMAILS[0].messages);
  assert.match(p, /sent on Thursday, 2026-09-24/);
  assert.match(p, /Rate for Dallas TX -> Atlanta GA/);
});

test('model output: code fences accepted, junk rejected', () => {
  assert.strictEqual(gas.parseModelOutput('```json\n{"is_quote_request": false, "lanes": []}\n```').isQuote, false);
  assert.throws(() => gas.parseModelOutput('Sorry, I cannot help'), /no JSON/);
  assert.throws(() => gas.parseModelOutput('{"lanes": []}'), /is_quote_request/);
  assert.throws(() => gas.parseModelOutput('{"is_quote_request": true, "lanes": []}'), /without lanes/);
});

test('model output: odd values normalized, unknown equipment counts as missing', () => {
  const lane = gas.normalizeLane({ origin_city: 'dallas', origin_state: 'tx', destination_city: 'N/A',
    destination_state: 'GA', equipment: 'Power only', weight_lbs: '40,000 lbs', pickup_date: 'Friday' });
  assert.deepStrictEqual({ ...lane.origin }, { city: 'Dallas', state: 'TX' });
  assert.strictEqual(lane.destination, null);
  assert.strictEqual(lane.weight_lbs, 40000);
  assert.deepStrictEqual([...lane.missing], ['destination', 'equipment', 'pickup_date']);
});

test('greeting skips numbers and keeps non-Latin names', () => {
  assert.strictEqual(gas.firstName('"23 Дима" <a@example.com>'), 'Дима');
  assert.strictEqual(gas.firstName('LAURA KIM <l@example.com>'), 'Laura');
  assert.strictEqual(gas.firstName('123 <x@example.com>'), '');
});
