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

test('greeting skips numbers and keeps accented names', () => {
  assert.strictEqual(gas.firstName('"23 José" <a@example.com>'), 'José');
  assert.strictEqual(gas.firstName('LAURA KIM <l@example.com>'), 'Laura');
  assert.strictEqual(gas.firstName('123 <x@example.com>'), '');
});

// A US evening email is already the next day in UTC: dates must come from the broker's time zone.
test('time zone: Thursday 9:30 PM in Chicago (Fri 02:30 UTC) is sent Thursday, so "Fri" is Sep 25', () => {
  const msgs = [{ from: 'A <a@example.com>', date: '2026-09-25T02:30:00Z', local: '2026-09-24 9:30 PM', body: 'Dallas TX to Atlanta GA, van, 40k, pickup Fri' }];
  const p = gas.buildPrompt(msgs, 'Rate');
  assert.match(p, /sent on Thursday, 2026-09-24/);
  assert.match(p, /2026-09-24 Thursday \(sent\); 2026-09-25 Friday;/);
  assert.match(p, /CUSTOMER \| 2026-09-24 9:30 PM/, 'thread shows local time, not UTC');
  assert.doesNotMatch(p, /02:30/);
});

test('US input: MM/DD dates and ZIP-only places are explained in the prompt', () => {
  const p = gas.buildPrompt(gas.DEMO_EMAILS[0].messages, 'x');
  assert.match(p, /"10\/2" is October 2/);
  assert.match(p, /ZIP/);
});

test('US values: state names become 2-letter codes, ZIPs are not cities, weights with k/tons', () => {
  const lane = (o) => gas.normalizeLane({ origin_city: 'Dallas', origin_state: 'TX', destination_city: 'Atlanta', destination_state: 'GA',
    equipment: 'dry van', weight_lbs: 40000, pickup_date: '2026-09-25', ...o });
  assert.strictEqual(lane({ origin_state: 'Texas' }).origin.state, 'TX');
  assert.strictEqual(lane({ destination_state: ' new york ' }).destination.state, 'NY');
  assert.strictEqual(lane({ origin_state: 'Tex' }).origin, null, 'unknown state -> ask');
  assert.strictEqual(lane({ origin_city: '75201' }).origin, null, 'a ZIP is not a city');
  assert.strictEqual(lane({ weight_lbs: '44k' }).weight_lbs, 44000);
  assert.strictEqual(lane({ weight_lbs: '22,500#' }).weight_lbs, 22500);
  assert.strictEqual(lane({ weight_lbs: '20 tons' }).weight_lbs, 40000);
  assert.strictEqual(lane({ pickup_date: '10/02/2026' }).pickup_date, '2026-10-02', 'US MM/DD/YYYY');
  assert.strictEqual(lane({ pickup_date: '10/2/26' }).pickup_date, '2026-10-02');
});

test('US output: "Fri, Sep 25", "$1,850", "44,000 lbs" in the draft', () => {
  const items = [{ lane: gas.normalizeLane({ origin_city: 'Dallas', origin_state: 'TX', destination_city: 'Atlanta', destination_state: 'GA',
    equipment: 'dry van', weight_lbs: 44000, pickup_date: '2026-09-25' }), quote: { kind: 'exact', rate: 1850 } }];
  const body = gas.composeReply('Laura <l@example.com>', items, settings);
  assert.match(body, /Dallas, TX to Atlanta, GA \(dry van, 44,000 lbs, pickup Fri, Sep 25\): \$1,850 all-in/);
  assert.match(gas.money(12500), /^\$12,500$/);
});

test('rate history typed as text ("$1,850") still counts', () => {
  const lane = gas.normalizeLane({ origin_city: 'Dallas', origin_state: 'TX', destination_city: 'Atlanta', destination_state: 'GA', equipment: 'dry van' });
  const q = gas.findRate(lane, [{ date: '2026-09-01', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', equipment: 'Dry Van', rate: '$1,850' }]);
  assert.deepStrictEqual({ ...q }, { kind: 'exact', rate: 1850, loads: 1 });
});

// Found by the stress test: the model wrote "Saint Louis", the expected answer and rate sheets say "St. Louis".
test('"Saint Louis" and "St Louis" are the same city, in the draft and in the rate lookup', () => {
  const lane = gas.normalizeLane({ origin_city: 'Kansas City', origin_state: 'MO', destination_city: 'Saint Louis', destination_state: 'MO', equipment: 'dry van' });
  assert.strictEqual(lane.destination.city, 'St. Louis');
  const q = gas.findRate(lane, [{ date: '2026-09-01', originCity: 'Kansas City', originState: 'MO', destCity: 'St Louis', destState: 'MO', equipment: 'dry van', rate: 900 }]);
  assert.strictEqual(q.kind, 'exact');
});

// Found by the stress test: "8 pallets, LTL" and "box truck" became "dry van" instead of a question.
test('prompt: equipment only when the customer asked for it', () => {
  assert.match(gas.buildPrompt(gas.DEMO_EMAILS[0].messages, 'x'), /not mentioned, LTL, box truck.* is null/);
});
