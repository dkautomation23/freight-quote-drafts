// Pure logic: no Gmail, no Sheets, no network. Tested in Node (test/).
// Apps Script loads every .gs file into one global scope, so these are globals there.

var REQUIRED_FIELDS = ['origin', 'destination', 'equipment', 'weight_lbs', 'pickup_date'];
var EQUIPMENT = ['dry van', 'reefer', 'flatbed'];

var QUESTION_TEXT = {
  origin: 'the pickup city and state',
  destination: 'the delivery city and state',
  equipment: 'the equipment type (dry van, reefer or flatbed)',
  weight_lbs: 'the total weight',
  pickup_date: 'the pickup date'
};

// Signatures, old quoted replies and phone lines only confuse the model.
function stripQuoted(body) {
  var lines = String(body || '').replace(/\r/g, '').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

// messages: [{from, date (ISO), local ("2026-09-24 9:30 PM" in the broker's time zone), body, isMine}], oldest first.
// "Fri" and "tomorrow" are the customer's words in US time: a Thursday-evening email is already Friday in UTC.
// Customers often put the whole request in the subject.
function buildPrompt(messages, subject) {
  var recent = messages.slice(-4);
  var last = recent[recent.length - 1];
  var when = function (m) { return m.local || m.date; };
  var ymd = when(last).slice(0, 10).split('-').map(Number);
  var d = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]));
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var weekday = days[d.getUTCDay()];
  // Models are bad at weekday arithmetic ("Fri" from a Thursday), so hand them a calendar.
  var calendar = [];
  for (var i = 0; i <= 14; i++) {
    var c = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] + i));
    calendar.push(c.toISOString().slice(0, 10) + ' ' + days[c.getUTCDay()] + (i === 0 ? ' (sent)' : ''));
  }
  var thread = recent.map(function (m) {
    return '--- ' + (m.isMine ? 'BROKER (us)' : 'CUSTOMER') + ' | ' + when(m) + '\n' + stripQuoted(m.body).slice(0, 4000);
  }).join('\n\n');

  return [
    'You read emails sent to a US freight broker and extract load details for a rate quote.',
    'The latest message was sent on ' + weekday + ', ' + d.toISOString().slice(0, 10) + ' (broker local date).',
    '',
    'Rules:',
    '- is_quote_request is true if the customer wants us to move freight or price a load, even without',
    '  the words "rate" or "quote" ("need this next Monday", "can you cover") and even when weight, date or',
    '  equipment are missing, LTL or a box truck: the draft asks for what is missing.',
    '  False: invoices, payment questions, PODs, confirmations of loads already booked, newsletters,',
    '  carriers offering their own trucks, and job applications.',
    '- One lane per origin/destination pair. An email can ask for several lanes.',
    '- Read the subject and the whole thread: later customer messages add or correct details of earlier ones.',
    '- Fix misspelled US city names. States as 2-letter codes (TX, GA).',
    '- A place given only as a ZIP code (75201): use its city and state if you are sure, otherwise null.',
    '- A multi-stop load on one truck is one lane: first pickup to final delivery.',
    '- equipment: "dry van", "reefer" or "flatbed". "53 ft van" or "van" is "dry van". Temperature-controlled is "reefer".',
    '  Only what the customer asked for: not mentioned, LTL, box truck, step deck, tanker or power only is null (we ask).',
    '- weight_lbs: a number. "44k" = 44000, "22,500#" = 22500. Tons are US tons (2000 lbs). Pallets without a weight: null.',
    '- pickup_date: YYYY-MM-DD. Resolve "Fri", "tomorrow", "next Thursday" with the calendar below; do not count days yourself.',
    '  "Fri" means the nearest coming Friday; "next Thursday" means the Thursday of the following week.',
    '  Dates are US month/day: "10/2" is October 2, "9/29-9/30" is September 29. "ASAP" alone is null.',
    '- Ignore addresses and phone numbers in signatures.',
    '- If a field is not stated, use null. Never guess.',
    '- notes: short, only special requirements (temperature, tarps, hazmat, LTL, pallet count). Otherwise "".',
    '',
    'Return JSON only, exactly this shape:',
    '{"is_quote_request": true, "lanes": [{"origin_city": "Dallas", "origin_state": "TX",',
    ' "destination_city": "Atlanta", "destination_state": "GA", "equipment": "dry van",',
    ' "weight_lbs": 40000, "pickup_date": "2026-09-25", "notes": ""}]}',
    '',
    'Calendar: ' + calendar.join('; '),
    '',
    'Subject: ' + String(subject || '').slice(0, 300),
    'Thread (oldest first):',
    thread
  ].join('\n');
}

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && (v.trim() === '' || /^(null|unknown|n\/a)$/i.test(v.trim()))) return null;
  return v;
}

function titleCase(s) {
  return String(s).trim().toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
}

var STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming'
};

// "Texas", "tx" -> "TX"; anything else -> null, so the draft asks instead of guessing.
function stateCode(s) {
  var t = String(s).trim().toLowerCase().replace(/\./g, '');
  if (STATES[t.toUpperCase()]) return t.toUpperCase();
  for (var code in STATES) if (STATES[code] === t) return code;
  return null;
}

function place(city, state) {
  city = blankToNull(city);
  var code = blankToNull(state) && stateCode(state);
  if (!city || !code || /\d/.test(city)) return null; // a ZIP is not a city
  // "Saint Louis", "st louis" -> "St. Louis", the way brokers write it in rate sheets.
  return { city: titleCase(city).replace(/^(Saint|St\.?)\s+/, 'St. '), state: code };
}

// "44k", "22,500#", "20 tons" -> lbs.
function weightLbs(w) {
  if (typeof w === 'number') return w;
  var t = String(w).toLowerCase().replace(/,/g, '');
  var n = parseFloat(t.replace(/[^0-9.]/g, ''));
  if (!(n > 0)) return null;
  if (/\d\s*k\b/.test(t)) return n * 1000;
  if (/\btons?\b/.test(t)) return n * 2000;
  return n;
}

// ISO, or US "10/02/2026" / "10/2/26".
function isoDate(v) {
  var t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  var m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  var pad = function (x) { return ('0' + x).slice(-2); };
  return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(m[1]) + '-' + pad(m[2]);
}

function normalizeLane(raw) {
  var lane = {};
  lane.origin = place(raw.origin_city, raw.origin_state);
  lane.destination = place(raw.destination_city, raw.destination_state);

  var eq = blankToNull(raw.equipment);
  eq = eq ? String(eq).trim().toLowerCase() : null;
  lane.equipment = EQUIPMENT.indexOf(eq) >= 0 ? eq : null;

  var w = blankToNull(raw.weight_lbs);
  w = w === null ? null : weightLbs(w);
  lane.weight_lbs = typeof w === 'number' && w > 0 ? Math.round(w) : null;

  var pd = blankToNull(raw.pickup_date);
  lane.pickup_date = pd ? isoDate(pd) : null;

  lane.notes = blankToNull(raw.notes) || '';
  lane.missing = REQUIRED_FIELDS.filter(function (f) { return lane[f] === null; });
  return lane;
}

// Throws on anything that is not the expected shape: the caller logs it and retries next run.
function parseModelOutput(text) {
  var s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model output has no JSON object');
  var obj = JSON.parse(s.slice(start, end + 1));
  if (typeof obj.is_quote_request !== 'boolean') throw new Error('is_quote_request missing');
  if (!obj.is_quote_request) return { isQuote: false, lanes: [] };
  if (!Array.isArray(obj.lanes) || obj.lanes.length === 0) throw new Error('quote request without lanes');
  return { isQuote: true, lanes: obj.lanes.map(normalizeLane) };
}

function median(nums) {
  var a = nums.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// rows: [{date, originCity, originState, destCity, destState, equipment, rate}]
// exact  = same cities + equipment: median of the 5 most recent loads.
// similar = same states + equipment: min-max range, for the broker to judge.
function findRate(lane, rows) {
  if (!lane.origin || !lane.destination || !lane.equipment) return { kind: 'none' };
  var key = function (s) { return String(s || '').trim().toLowerCase().replace(/^(saint|st\.?)\s+/, 'st. '); };
  var num = function (v) { return Number(String(v).replace(/[$,\s]/g, '')); }; // "$1,850" typed as text
  rows = rows.map(function (r) { var c = {}; for (var k in r) c[k] = r[k]; c.rate = num(r.rate); return c; });
  var sameEq = rows.filter(function (r) { return key(r.equipment) === lane.equipment && r.rate > 0; });
  var byDate = function (a, b) { return new Date(b.date) - new Date(a.date); };

  var exact = sameEq.filter(function (r) {
    return key(r.originCity) === key(lane.origin.city) && key(r.originState) === key(lane.origin.state) &&
      key(r.destCity) === key(lane.destination.city) && key(r.destState) === key(lane.destination.state);
  }).sort(byDate).slice(0, 5);
  if (exact.length) {
    var rate = Math.round(median(exact.map(function (r) { return Number(r.rate); })) / 5) * 5;
    return { kind: 'exact', rate: rate, loads: exact.length };
  }

  var similar = sameEq.filter(function (r) {
    return key(r.originState) === key(lane.origin.state) && key(r.destState) === key(lane.destination.state);
  });
  if (similar.length) {
    var rates = similar.map(function (r) { return Number(r.rate); });
    return { kind: 'similar', min: Math.min.apply(null, rates), max: Math.max.apply(null, rates), loads: similar.length };
  }
  return { kind: 'none' };
}

function money(n) {
  return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(iso) {
  var d = new Date(iso + 'T12:00:00Z');
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getUTCDay()] + ', ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

function laneTitle(lane) {
  var place = function (p, fallback) { return p ? p.city + ', ' + p.state : fallback; };
  return place(lane.origin, '(pickup city?)') + ' to ' + place(lane.destination, '(delivery city?)');
}

function laneDetails(lane) {
  var parts = [];
  if (lane.equipment) parts.push(lane.equipment);
  if (lane.weight_lbs) parts.push(String(lane.weight_lbs).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' lbs');
  if (lane.pickup_date) parts.push('pickup ' + formatDate(lane.pickup_date));
  if (lane.notes) parts.push(lane.notes.charAt(0).toLowerCase() + lane.notes.slice(1));
  return parts.join(', ');
}

// Anything in [BRACKETS] is for the broker to fill in before sending.
function rateText(quote) {
  if (quote.kind === 'exact') return money(quote.rate) + ' all-in';
  if (quote.kind === 'similar') return '[RATE: no loads on this exact lane; similar lanes paid ' + money(quote.min) + '-' + money(quote.max) + ']';
  return '[RATE: no history for this lane]';
}

// First word made of letters only: "23 Dima" greets Dima, a bare address greets "there".
function firstName(from) {
  var name = String(from || '').replace(/<.*>/, '').replace(/"/g, '').trim();
  if (!name || name.indexOf('@') >= 0) return '';
  var word = name.split(/\s+/).filter(function (w) { return /^[A-Za-zÀ-ɏЀ-ӿ'-]+$/.test(w); })[0];
  return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '';
}

// items: [{lane, quote}] from findRate. settings: {signerName, companyName}.
function composeReply(customerFrom, items, settings) {
  var hi = firstName(customerFrom);
  var lines = ['Hi ' + (hi || 'there') + ',', '', 'Thanks for your request.'];
  var priced = items.filter(function (it) { return it.lane.origin && it.lane.destination; });

  if (priced.length) {
    lines.push('');
    lines.push(priced.length > 1 ? 'Here are our rates:' : 'Here is our rate:');
    priced.forEach(function (it) {
      var details = laneDetails(it.lane);
      lines.push('- ' + laneTitle(it.lane) + (details ? ' (' + details + ')' : '') + ': ' + rateText(it.quote));
    });
  }

  var asking = items.filter(function (it) { return it.lane.missing.length; });
  if (asking.length) {
    lines.push('');
    lines.push('To confirm the rate, could you tell me:');
    asking.forEach(function (it) {
      var prefix = items.length > 1 ? laneTitle(it.lane) + ': ' : '';
      lines.push('- ' + prefix + it.lane.missing.map(function (f) { return QUESTION_TEXT[f]; }).join(', '));
    });
  }

  lines.push('');
  lines.push(priced.length > 1 ? 'Let me know which loads you would like to book.' : 'Let me know if you would like to book it.');
  lines.push('');
  lines.push('Best regards,');
  if (settings.signerName) lines.push(settings.signerName);
  if (settings.companyName) lines.push(settings.companyName);
  return lines.join('\n');
}

// One call per thread: model text in, everything the Gmail side needs out.
function planReply(messages, modelText, rateRows, settings) { // modelText from callModel(buildPrompt(messages, subject))
  var parsed = parseModelOutput(modelText);
  if (!parsed.isQuote) return { action: 'skip', lanes: [] };
  var items = parsed.lanes.map(function (lane) { return { lane: lane, quote: findRate(lane, rateRows) }; });
  var customer = messages.filter(function (m) { return !m.isMine; }).pop();
  return {
    action: 'draft',
    items: items,
    body: composeReply(customer ? customer.from : '', items, settings)
  };
}

