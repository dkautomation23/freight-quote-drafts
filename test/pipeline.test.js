// Runs Main.gs against a fake Gmail, fake Sheets and a fake Gemini endpoint that
// returns the recorded answers. Checks the acceptance rule: every quote email gets
// one draft in its own thread and the "Quote ready" label; nothing is ever sent.
const test = require('node:test');
const assert = require('node:assert');
const { loadGas, recorded } = require('./gas.js');

const ME = 'me@example.com';
const forbidden = (what) => () => { throw new Error('tried to ' + what); };

function fakeSheet(name) {
  const rows = [];
  const sheet = {
    name, rows,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    appendRow: (r) => { rows.push(r); },
    getRange: (row, col, n) => ({
      setValues: (vals) => { vals.forEach((v, i) => { rows[row - 1 + i] = v.slice(); }); return { setFontWeight: () => {} }; }
    }),
    setFrozenRows: () => {}
  };
  return sheet;
}

function world(emails, recordedFor) {
  const sheets = {};
  const labels = {};
  const props = {};
  const triggers = [];
  const calls = { model: 0 };
  let failModelFor = null;
  let garbageFor = null;
  let failLabel = false;
  let msgSeq = 0;

  const makeMessage = (thread, m) => ({
    id: 'm' + (++msgSeq), m,
    getId() { return this.id; },
    getFrom: () => (m.isMine ? `Sam Reyes <${ME}>` : m.from),
    getDate: () => new Date(m.date),
    getPlainBody: () => m.body,
    isDraft: () => false,
    createDraftReply: (body) => { thread.drafts.push(body); },
    reply: forbidden('reply'), replyAll: forbidden('reply all'), forward: forbidden('forward')
  });

  const threads = emails.map((e) => {
    const thread = {
      id: e.id, subject: e.subject, drafts: [], labels: [], messages: [],
      getMessages() { return this.messages; },
      getFirstMessageSubject() { return this.subject; },
      addLabel(l) { if (failLabel) throw new Error('label service busy'); if (!this.labels.includes(l.name)) this.labels.push(l.name); },
      reply: forbidden('reply'), createDraftReply: forbidden('draft on the thread instead of the customer message')
    };
    thread.messages = e.messages.map((m) => makeMessage(thread, m));
    return thread;
  });

  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = fakeSheet(n)),
    toast: () => {}
  };

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({
        Button: { OK: 'OK' }, ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
        prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => 'test-key' }),
        createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} })
      })
    },
    GmailApp: {
      getUserLabelByName: (n) => labels[n] || null,
      createLabel: (n) => (labels[n] = { name: n }),
      search: (q) => { assert.match(q, /in:inbox/); return threads.slice().reverse(); }, // Gmail: newest first
      sendEmail: forbidden('send email')
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => triggers.push({ fn, n, getHandlerFunction: () => fn }) }) }) })
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => ME }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { sleep: () => {} },
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.model++;
        assert.strictEqual(opts.headers['x-goog-api-key'], 'test-key');
        assert.ok(url.includes('gemini-flash-latest:generateContent'));
        const prompt = JSON.parse(opts.payload).contents[0].parts[0].text;
        const email = emails.find((e) => prompt.includes(e.messages[0].body.slice(0, 30)));
        if (email.id === failModelFor) return { getResponseCode: () => 503, getContentText: () => 'overloaded' };
        if (email.id === garbageFor) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help' }] } }] }) };
        const text = recordedFor(email.id);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
      }
    }
  };

  return {
    gas: loadGas(globals), threads, sheets, labels, props, triggers, calls,
    failModel: (id) => { failModelFor = id; },
    garbage: (id) => { garbageFor = id; },
    failLabels: (on) => { failLabel = on; },
    addMessage: (threadId, m) => { const t = threads.find((x) => x.id === threadId); t.messages.push(makeMessage(t, m)); },
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
  assert.deepStrictEqual(Object.keys(w.sheets).sort(), ['Log', 'Rate history', 'Settings']);
  assert.strictEqual(w.sheets['Rate history'].rows.length, 21);
  assert.ok(w.labels['Quote ready'] && w.labels['Not a quote']);
  assert.strictEqual(w.props.GEMINI_API_KEY, 'test-key');
  w.gas.setup(); // running Setup twice must not stack triggers
  assert.strictEqual(w.triggers.length, 1);
  assert.strictEqual(w.triggers[0].n, 5);
});

test('10 emails: 9 drafts in their own threads with "Quote ready", 1 skipped, nothing sent', () => {
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
  assert.strictEqual(log.length, 10);
  assert.strictEqual(log.filter((r) => r[4] === 'draft').length, 9);
  assert.strictEqual(log.find((r) => r[3] === 'Rate request Dallas to Atlanta')[6], '$1,850');
});

test('second run: no duplicate drafts, no extra model calls', () => {
  const w = freshWorld();
  w.gas.processInbox();
  const calls = w.calls.model;
  w.gas.processInbox();
  assert.strictEqual(w.calls.model, calls);
  assert.ok(w.threads.every((t) => t.drafts.length <= 1));
  assert.strictEqual(w.log().length, 10);
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
  assert.strictEqual(w.log().length, 9);
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
  assert.strictEqual(w.threads.filter((t) => t.drafts.length === 1).length, 27);
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
