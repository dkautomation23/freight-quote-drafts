// Runs Main.gs against a fake Gmail, fake Sheets and a fake Gemini endpoint that
// returns the recorded answers. Checks the acceptance rule: every quote email gets
// one draft in its own thread and the "Quote ready" label; nothing is ever sent.
const test = require('node:test');
const assert = require('node:assert');
const { loadGas, recorded } = require('./gas.js');
const { formatLocal, LOCAL_PATTERN } = require('./tz.js');

const ME = 'me@example.com';
const forbidden = (what) => () => { throw new Error('tried to ' + what); };

// Formatting calls (fonts, colors, widths) are accepted and ignored; values are real.
const anything = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : anything), apply: () => anything() });
const chain = (real) => new Proxy(real, { get: (t, k) => (k in t ? t[k] : () => chain(real)) });

function fakeSheet(name) {
  const rows = [];
  const sheet = {
    name, rows, frozen: 0,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(1, ...rows.map((r) => r.length)),
    appendRow: (r) => { rows.push(r); },
    insertRowBefore: (n) => { rows.splice(n - 1, 0, []); },
    clear: () => { rows.length = 0; },
    setFrozenRows: (n) => { sheet.frozen = n; },
    getRange: (row, col, n, width) => chain({
      getValues: () => rows.slice(row - 1, row - 1 + n).map((r) => r.slice(col - 1, col - 1 + width)),
      setValues: (vals) => {
        if (typeof row !== 'number') return chain({});
        vals.forEach((v, i) => { const r = rows[row - 1 + i] || (rows[row - 1 + i] = []); v.forEach((x, j) => { r[col - 1 + j] = x; }); });
        return chain({});
      }
    })
  };
  return chain(sheet);
}

function world(emails, recordedFor) {
  const sheets = {};
  const labels = {};
  const props = {};
  const triggers = [];
  const calls = { model: 0, prompts: [] };
  let failModelFor = null;
  let garbageFor = null;
  let proxy = null;
  let failLabel = false;
  let msgSeq = 0;

  // Gmail API shapes (Users.Threads.get format "full"): headers + base64url body, ids like the real ones.
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
  const makeMessage = (thread, m, labelIds) => {
    const id = 'm' + (++msgSeq);
    const from = m.isMine ? `Sam Reyes <${ME}>` : m.from;
    const payload = m.html
      ? { mimeType: 'multipart/alternative', headers: [], parts: [{ mimeType: 'text/html', body: { data: b64(m.html) } }] }
      : { mimeType: 'text/plain', headers: [], body: { data: b64(m.body) } };
    payload.headers = [{ name: 'From', value: from }, { name: 'Subject', value: thread.subject }, { name: 'Message-ID', value: `<${id}@mail.example.com>` }];
    return { id, threadId: thread.id, labelIds: labelIds || (m.isMine ? ['SENT'] : ['INBOX']), internalDate: String(Date.parse(m.date)), payload };
  };

  const threads = emails.map((e) => {
    const thread = { id: e.id, subject: e.subject, drafts: [], draftMime: [], labels: [], messages: [] };
    thread.messages = e.messages.map((m) => makeMessage(thread, m));
    return thread;
  });
  const byId = (id) => threads.find((t) => t.id === id);
  let labelSeq = 0;

  const order = [];
  let active = null;
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n, at) => { order.splice(at === undefined ? order.length : at, 0, n); return (sheets[n] = fakeSheet(n)); },
    getSpreadsheetTimeZone: () => 'America/Chicago',
    setActiveSheet: (sh) => { active = sh.name; },
    moveActiveSheet: (pos) => { order.splice(order.indexOf(active), 1); order.splice(pos - 1, 0, active); },
    toast: () => {}
  };

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newConditionalFormatRule: anything,
      getUi: () => ({
        Button: { OK: 'OK' }, ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
        prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => 'test-key' }),
        createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} })
      })
    },
    Gmail: { Users: {
      getProfile: () => ({ emailAddress: ME }),
      Labels: {
        list: () => ({ labels: Object.values(labels) }),
        create: (res) => (labels[res.name] = { id: 'Label_' + (++labelSeq), name: res.name })
      },
      Threads: {
        list: (user, opts) => { assert.match(opts.q, /in:inbox/); return { threads: threads.slice().reverse().map((t) => ({ id: t.id })) }; }, // newest first
        get: (user, id, opts) => { assert.strictEqual(opts.format, 'full'); return JSON.parse(JSON.stringify({ id, messages: byId(id).messages })); },
        modify: (res, user, id) => {
          if (failLabel) throw new Error('label service busy');
          for (const lid of res.addLabelIds) { const name = Object.values(labels).find((l) => l.id === lid).name; if (!byId(id).labels.includes(name)) byId(id).labels.push(name); }
          assert.ok(!res.removeLabelIds, 'never removes labels');
        },
        trash: forbidden('trash a thread'), delete: forbidden('delete a thread')
      },
      Drafts: {
        create: (res) => {
          const t = byId(res.message.threadId);
          const raw = Buffer.from(res.message.raw, 'base64url').toString('utf8');
          const cut = raw.indexOf('\r\n\r\n');
          t.draftMime.push(raw.slice(0, cut));
          t.drafts.push(raw.slice(cut + 4));
          t.messages.push(makeMessage(t, { isMine: true, date: new Date().toISOString(), body: raw.slice(cut + 4) }, ['DRAFT'])); // Gmail shows drafts inside the thread
          return { id: 'r' + msgSeq };
        },
        send: forbidden('send a draft')
      },
      Messages: { send: forbidden('send'), trash: forbidden('trash'), delete: forbidden('delete') }
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => triggers.push({ fn, n, getHandlerFunction: () => fn }) }) }) })
    },
    Session: { getEffectiveUser: forbidden('ask for the user email scope'), getScriptTimeZone: () => 'America/Chicago' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      sleep: () => {},
      Charset: { UTF_8: 'UTF-8' },
      base64EncodeWebSafe: (text) => Buffer.from(text, 'utf8').toString('base64url'),
      base64DecodeWebSafe: (data) => [...Buffer.from(data, 'base64url')],
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      formatDate: (d, tz, pattern) => { assert.strictEqual(pattern, LOCAL_PATTERN); return formatLocal(d, tz); } },
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.model++;
        if (proxy) return proxy(url, opts);
        assert.strictEqual(opts.headers['x-goog-api-key'], 'test-key');
        assert.ok(url.includes('gemini-flash-latest:generateContent'));
        const prompt = JSON.parse(opts.payload).contents[0].parts[0].text;
        calls.prompts.push(prompt);
        const email = emails.find((e) => prompt.includes('Subject: ' + e.subject + String.fromCharCode(10)));
        if (email.id === failModelFor) return { getResponseCode: () => 503, getContentText: () => 'overloaded' };
        if (email.id === garbageFor) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help' }] } }] }) };
        const text = recordedFor(email.id);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
      }
    }
  };

  return {
    gas: loadGas(globals), threads, sheets, order, labels, props, triggers, calls,
    failModel: (id) => { failModelFor = id; },
    garbage: (id) => { garbageFor = id; },
    useProxy: (fn) => { proxy = fn; },
    failLabels: (on) => { failLabel = on; },
    addMessage: (threadId, m) => { const t = byId(threadId); t.messages.push(makeMessage(t, m)); },
    log: () => sheets.Log.rows.slice(1)
  };
}

function freshWorld() {
  const w = world(loadGas().DEMO_EMAILS, recorded);
  w.gas.setup();
  return w;
}

test('setup: sheets, labels, key and one 5-minute trigger', () => {
  const w = freshWorld();
  assert.deepStrictEqual(w.order, ['Start here', 'Rate history', 'Settings', 'Log']);
  assert.ok(['Rate history', 'Settings', 'Log'].every((n) => w.sheets[n].frozen === 1), 'frozen headers');
  assert.deepStrictEqual(w.sheets['Start here'].rows.filter((r) => /^[123]$/.test(r[0])).map((r) => r[0]), ['1', '2', '3']);
  const tz = w.sheets.Settings.rows.find((r) => r[0] === 'Time zone');
  assert.strictEqual(tz[1], 'America/Chicago');
  assert.match(tz[2], /America\/New_York/, 'hint next to the field');
  assert.strictEqual(w.sheets['Rate history'].rows.length, 21);
  assert.ok(w.labels['Quote ready'] && w.labels['Not a quote']);
  assert.strictEqual(w.props.GEMINI_API_KEY, 'test-key');
  w.gas.setup(); // running Setup twice must not stack triggers
  assert.strictEqual(w.triggers.length, 1);
  assert.strictEqual(w.triggers[0].n, 5);
});

test('11 emails: 10 drafts in their own threads with "Quote ready", 1 skipped, nothing sent', () => {
  const w = freshWorld();
  w.gas.processInbox();
  for (const t of w.threads) {
    if (t.id === '07-not-a-quote') {
      assert.strictEqual(t.drafts.length, 0);
      assert.deepStrictEqual(t.labels, ['Not a quote']);
    } else {
      assert.strictEqual(t.drafts.length, 1, t.id);
      assert.deepStrictEqual(t.labels, ['Quote ready'], t.id);
    }
  }
  const log = w.log();
  assert.strictEqual(log.length, 11);
  assert.strictEqual(log.filter((r) => r[4] === 'draft').length, 10);
  assert.strictEqual(log.find((r) => r[3] === 'Rate request Dallas to Atlanta')[6], '$1,850');
});

test('second run: no duplicate drafts, no extra model calls', () => {
  const w = freshWorld();
  w.gas.processInbox();
  const calls = w.calls.model;
  w.gas.processInbox();
  assert.strictEqual(w.calls.model, calls);
  assert.ok(w.threads.every((t) => t.drafts.length <= 1));
  assert.strictEqual(w.log().length, 11);
});

test('model down: logged as error, no label, retried on the next run', () => {
  const w = freshWorld();
  w.failModel('01-full');
  w.gas.processInbox();
  const t = w.threads.find((x) => x.id === '01-full');
  assert.strictEqual(t.drafts.length, 0);
  assert.deepStrictEqual(t.labels, []);
  assert.match(w.log().find((r) => r[4] === 'error')[8], /model http 503/);

  w.failModel(null);
  w.gas.processInbox();
  assert.strictEqual(t.drafts.length, 1);
  assert.deepStrictEqual(t.labels, ['Quote ready']);
});

test('customer writes again in a drafted thread: a new draft for the new message', () => {
  const w = freshWorld();
  w.gas.processInbox();
  w.addMessage('02-no-weight', { from: 'Carlos Mendes <cmendes@example.net>', date: '2026-09-24T16:00:00Z', body: 'Weight is 41,000 lbs.' });
  w.gas.processInbox();
  const t = w.threads.find((x) => x.id === '02-no-weight');
  assert.strictEqual(t.drafts.length, 2);
});

test('we wrote last: the thread is left alone', () => {
  const w = freshWorld();
  w.addMessage('01-full', { isMine: true, date: '2026-09-24T14:30:00Z', body: 'Hi Laura, $1,850 all-in.' });
  w.gas.processInbox();
  const t = w.threads.find((x) => x.id === '01-full');
  assert.strictEqual(t.drafts.length, 0);
  assert.strictEqual(w.log().length, 10);
});

test('busy inbox: at most 20 model calls per run, the rest next run, oldest first', () => {
  const base = loadGas().DEMO_EMAILS.filter((e) => e.id !== '07-not-a-quote');
  const many = [0, 1, 2].flatMap((n) => base.map((e) => ({ ...e, id: e.id + '#' + n })));
  const w = world(many, (id) => recorded(id.split('#')[0]));
  w.gas.setup();
  w.gas.processInbox();
  assert.strictEqual(w.calls.model, 20);
  assert.ok(w.threads.slice(0, 20).every((t) => t.drafts.length === 1), 'oldest 20 first');
  w.gas.processInbox();
  assert.strictEqual(w.threads.filter((t) => t.drafts.length === 1).length, 30);
});

test('label fails after the draft was made: logged, and no second draft next run', () => {
  const w = freshWorld();
  w.failLabels(true);
  w.gas.processInbox();
  w.failLabels(false);
  w.gas.processInbox();
  assert.ok(w.threads.every((t) => t.drafts.length <= 1));
  const row = w.log().find((r) => r[3] === 'Rate request Dallas to Atlanta');
  assert.strictEqual(row[4], 'draft');
  assert.match(row[8], /label service busy/);
});

test('model cannot read an email: 3 attempts, then it is left for a person', () => {
  const w = freshWorld();
  w.garbage('01-full');
  for (let i = 0; i < 5; i++) w.gas.processInbox();
  const errors = w.log().filter((r) => r[4] === 'error');
  assert.strictEqual(errors.length, 3);
  assert.strictEqual(w.threads.find((x) => x.id === '01-full').drafts.length, 0);
});

test('AI service busy: the run stops after one call, and it never counts as an attempt', () => {
  const w = freshWorld();
  w.failModel('01-full'); // the oldest email, so it is the first call of every run
  for (let i = 0; i < 5; i++) w.gas.processInbox();
  assert.strictEqual(w.calls.model, 5, 'one call per run while the service is down');
  w.failModel(null);
  w.gas.processInbox();
  assert.strictEqual(w.threads.find((x) => x.id === '01-full').drafts.length, 1, 'still retried after 5 failures');
});

test('client token set: calls go to the proxy with the token, never to Gemini', () => {
  const w = freshWorld();
  w.gas.PROXY_URL = 'https://quote-proxy.test/';
  w.sheets.Settings.rows.find((r) => r[0] === 'Client token')[1] = 'qa_client_token';
  const seen = [];
  w.useProxy((url, opts) => {
    seen.push({ url, token: opts.headers['x-client-token'], body: JSON.parse(opts.payload) });
    const id = loadGas().DEMO_EMAILS.find((e) => seen[seen.length - 1].body.prompt.includes('Subject: ' + e.subject + String.fromCharCode(10))).id;
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ text: recorded(id) }) };
  });
  w.gas.processInbox();
  assert.strictEqual(seen.length, 11);
  assert.ok(seen.every((c) => c.url === 'https://quote-proxy.test/' && c.token === 'qa_client_token'));
  assert.ok(seen.every((c) => Object.keys(c.body).join() === 'prompt'), 'only the prompt is sent');
  assert.strictEqual(w.threads.filter((t) => t.drafts.length === 1).length, 10);
});

test('proxy says the client is paused: no drafts, the reason in the Log, retried later', () => {
  const w = freshWorld();
  w.gas.PROXY_URL = 'https://quote-proxy.test/';
  w.sheets.Settings.rows.find((r) => r[0] === 'Client token')[1] = 'qa_client_token';
  w.useProxy(() => ({ getResponseCode: () => 402, getContentText: () => JSON.stringify({ error: 'service paused - contact Dmytro' }) }));
  w.gas.processInbox();
  assert.strictEqual(w.calls.model, 1, 'the run stops after the first refusal');
  assert.ok(w.threads.every((t) => t.drafts.length === 0));
  assert.match(w.log()[0][8], /402: service paused - contact Dmytro/);
});

test('big Log (30,000 old rows): only the tail is read, new mail still handled once', () => {
  const w = freshWorld();
  const old = [];
  for (let i = 0; i < 30000; i++) old.push([new Date(), 'old-' + i, 'x', 'old', 'draft', '', '', '', '']);
  w.sheets.Log.rows.push(...old);
  let widest = 0;
  const getRange = w.sheets.Log.getRange;
  w.sheets.Log.getRange = (row, col, n, width) => { if (n && n > widest) widest = n; return getRange(row, col, n, width); };
  w.gas.processInbox();
  assert.ok(widest <= 3000, 'read ' + widest + ' rows');
  assert.strictEqual(w.threads.filter((t) => t.drafts.length === 1).length, 10);
});

test('time zone: an evening email in Chicago is dated by the sheet time zone, not UTC', () => {
  const email = { id: 'tz', subject: 'Rate Dallas to Atlanta', messages: [{ from: 'Laura Kim <laura.kim@example.com>',
    date: '2026-09-25T02:30:00Z', body: 'Dallas TX to Atlanta GA, dry van, 40,000 lbs, pickup Fri' }] };
  const w = world([email], () => recorded('01-full'));
  w.gas.setup();
  w.gas.processInbox();
  assert.match(w.calls.prompts[0], /sent on Thursday, 2026-09-24/);
  assert.match(w.calls.prompts[0], /CUSTOMER \| 2026-09-24 9:30 PM/);
  assert.match(w.threads[0].drafts[0], /pickup Fri, Sep 25/);
});

test('Log: newest row on top, readable "missing" names; an older copy gets the new settings on Setup', () => {
  const w = freshWorld();
  w.gas.processInbox();
  const log = w.log();
  assert.match(log[0][3], /^Rate for Memphis/, 'the newest email (11-subject-only) is the first row');
  assert.strictEqual(log.find((r) => r[3] === 'Quote Houston - Memphis')[7], 'weight');
  w.sheets.Settings.rows.splice(w.sheets.Settings.rows.findIndex((r) => r[0] === 'Time zone'), 1);
  w.gas.setup();
  assert.strictEqual(w.sheets.Settings.rows.filter((r) => r[0] === 'Time zone').length, 1);
  assert.strictEqual(w.sheets.Settings.rows.filter((r) => r[0] === 'Your name').length, 1, 'no duplicates');
});

test('draft lands in the same thread: threadId, Re: subject, In-Reply-To and References of the last message', () => {
  const w = freshWorld();
  w.addMessage('02-no-weight', { from: 'Carlos Mendes <cmendes@example.net>', date: '2026-09-24T16:00:00Z', body: 'Weight is 41,000 lbs.' });
  w.gas.processInbox();
  const t = w.threads.find((x) => x.id === '02-no-weight');
  const last = t.messages.filter((m) => !m.labelIds.includes('DRAFT')).pop();
  const lastId = last.payload.headers.find((h) => h.name === 'Message-ID').value;
  const mime = t.draftMime[0];
  assert.match(mime, /^To: Carlos Mendes <cmendes@example\.net>/m);
  assert.match(mime, /^Subject: Re: Quote Houston - Memphis$/m);
  assert.match(mime, new RegExp('^In-Reply-To: ' + lastId + '$', 'm'));
  assert.match(mime, new RegExp('^References: .*' + lastId + '$', 'm'));
});

test('HTML-only email: the text is read without tags', () => {
  const email = { id: 'html', subject: 'Rate Dallas to Atlanta', messages: [{ from: 'Laura Kim <laura.kim@example.com>',
    date: '2026-09-24T14:05:00Z', html: '<div>Dallas TX&nbsp;to Atlanta GA<br>dry van, 40,000 lbs</div>' }] };
  const w = world([email], () => recorded('01-full'));
  w.gas.setup();
  w.gas.processInbox();
  assert.match(w.calls.prompts[0], /Dallas TX to Atlanta GA\s*\ndry van, 40,000 lbs/);
  assert.doesNotMatch(w.calls.prompts[0], /<div>|&nbsp;/);
});

test('permissions: no GmailApp (full mail access), only the narrow scopes in the manifest', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Main.gs'), 'utf8');
  assert.doesNotMatch(src, /GmailApp\./);
  const scopes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8')).oauthScopes;
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.modify'));
  assert.ok(!scopes.some((s) => s === 'https://mail.google.com/' || /gmail\.send|spreadsheets$|drive/.test(s)), scopes.join());
});
