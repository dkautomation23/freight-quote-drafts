// Gmail + Sheets side. Creates drafts only: nothing in this project sends email.

var LABEL_READY = 'Quote ready';
var LABEL_SKIPPED = 'Not a quote';
var SHEET_RATES = 'Rate history';
var SHEET_LOG = 'Log';
var SHEET_SETTINGS = 'Settings';
var LOG_HEADERS = ['Time', 'Message ID', 'From', 'Subject', 'Result', 'Lanes', 'Rates', 'Missing', 'Error'];
var THREADS_TO_SCAN = 100;    // already handled threads are cheap: no model call
var MAX_ATTEMPTS = 3;          // a failing email is retried on the next 2 runs, then left for a person
var MAX_MODEL_CALLS_PER_RUN = 20; // with the 7 s pause, well inside the 6-minute Apps Script limit

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Quote Assistant')
    .addItem('Setup', 'setup')
    .addItem('Check inbox now', 'processInbox')
    .addSeparator()
    .addItem('Load demo emails', 'loadDemoEmails')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SHEET_RATES, RATE_HEADERS, DEMO_RATES);
  ensureSheet(ss, SHEET_LOG, LOG_HEADERS, []);
  ensureSheet(ss, SHEET_SETTINGS, ['Setting', 'Value'], [
    ['Your name', DEMO_BROKER],
    ['Company name', DEMO_COMPANY],
    ['Model', 'gemini-2.5-flash']
  ]);
  GmailApp.getUserLabelByName(LABEL_READY) || GmailApp.createLabel(LABEL_READY);
  GmailApp.getUserLabelByName(LABEL_SKIPPED) || GmailApp.createLabel(LABEL_SKIPPED);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GEMINI_API_KEY')) {
    var ui = SpreadsheetApp.getUi();
    var res = ui.prompt('Quote Assistant', 'Paste your Gemini API key (kept in this script\'s properties, not in the sheet):', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() === ui.Button.OK && res.getResponseText().trim()) {
      props.setProperty('GEMINI_API_KEY', res.getResponseText().trim());
    }
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  ss.toast('Checking the inbox every 5 minutes. Drafts only, nothing is sent.', 'Quote Assistant', 8);
}

function ensureSheet(ss, name, headers, rows) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.setFrozenRows(1);
  return sh;
}

function readSettings(ss) {
  var out = { signerName: '', companyName: '', model: 'gemini-2.5-flash' };
  var sh = ss.getSheetByName(SHEET_SETTINGS);
  if (!sh) return out;
  sh.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0] === 'Your name') out.signerName = String(r[1]);
    if (r[0] === 'Company name') out.companyName = String(r[1]);
    if (r[0] === 'Model' && r[1]) out.model = String(r[1]);
  });
  return out;
}

// The only function that talks to the AI. Swap the body for a proxy or the Claude API later.
function callModel(prompt, model) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('No Gemini API key: run Quote Assistant > Setup');
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    })
  });
  if (res.getResponseCode() !== 200) throw new Error('model http ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  var data = JSON.parse(res.getContentText());
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(function (p) { return p.text || ''; }).join('');
}

function toPlainMessages(gmailMessages, myEmail) {
  return gmailMessages.map(function (m) {
    return {
      from: m.getFrom(),
      date: m.getDate().toISOString(),
      body: m.getPlainBody(),
      isMine: m.getFrom().toLowerCase().indexOf(myEmail) >= 0
    };
  });
}

function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous run is still going
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var settings = readSettings(ss);
    var rateRows = rateRowsFromTable(ss.getSheetByName(SHEET_RATES).getDataRange().getValues().slice(1));
    var logSheet = ss.getSheetByName(SHEET_LOG);
    var done = {}, errors = {};
    logSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[4] !== 'error') done[r[1]] = true;
      else if ((errors[r[1]] = (errors[r[1]] || 0) + 1) >= MAX_ATTEMPTS) done[r[1]] = true; // give up, stays in Log
    });
    var myEmail = Session.getEffectiveUser().getEmail().toLowerCase();
    var ready = GmailApp.getUserLabelByName(LABEL_READY) || GmailApp.createLabel(LABEL_READY);
    var skipped = GmailApp.getUserLabelByName(LABEL_SKIPPED) || GmailApp.createLabel(LABEL_SKIPPED);

    var threads = GmailApp.search('in:inbox newer_than:2d', 0, THREADS_TO_SCAN).reverse(); // oldest first
    var modelCalls = 0;
    threads.forEach(function (thread) {
      if (modelCalls >= MAX_MODEL_CALLS_PER_RUN) return; // the rest wait for the next run
      var msgs = thread.getMessages().filter(function (m) { return !m.isDraft(); });
      var last = msgs[msgs.length - 1];
      if (!last || done[last.getId()]) return;
      var plain = toPlainMessages(msgs, myEmail);
      if (plain[plain.length - 1].isMine) return; // we wrote last: nothing to answer

      var row = [new Date(), last.getId(), last.getFrom(), thread.getFirstMessageSubject(), '', '', '', '', ''];
      try {
        modelCalls++;
        var modelText = callModel(buildPrompt(plain), settings.model);
        Utilities.sleep(7000); // stay under the free Gemini tier's per-minute limit
        var plan = planReply(plain, modelText, rateRows, settings);
        if (plan.action === 'skip') {
          thread.addLabel(skipped);
          row[4] = 'skipped: not a quote';
        } else {
          last.createDraftReply(plan.body);
          row[4] = 'draft'; // set before anything else can fail: a draft must never be created twice
          row[5] = plan.items.map(function (it) { return laneTitle(it.lane); }).join('; ');
          row[6] = plan.items.map(function (it) { return it.quote.kind === 'exact' ? money(it.quote.rate) : it.quote.kind; }).join('; ');
          row[7] = plan.items.map(function (it) { return it.lane.missing.join(', '); }).filter(String).join('; ');
          thread.addLabel(ready);
        }
      } catch (e) {
        if (row[4] !== 'draft') row[4] = 'error';
        row[8] = String(e.message || e).slice(0, 300);
      }
      logSheet.appendRow(row);
      done[last.getId()] = true;
    });
  } finally {
    lock.releaseLock();
  }
}

// Puts the 10 invented emails straight into this inbox (Gmail API insert: nothing is sent).
// Needs the Gmail advanced service, enabled in appsscript.json.
function loadDemoEmails() {
  var me = Session.getEffectiveUser().getEmail();
  var base = Date.now() - 60 * 60 * 1000;
  DEMO_EMAILS.forEach(function (email, i) {
    var threadId = null, prevId = null;
    email.messages.forEach(function (m, j) {
      var msgId = '<demo-' + email.id + '-' + j + '-' + base + '@example.com>';
      var subject = j === 0 ? email.subject.replace(/^Re:\s*/, '') : email.subject;
      var headers = [
        'From: ' + (m.isMine ? me : m.from),
        'To: ' + (m.isMine ? m.from : me),
        'Subject: ' + subject,
        'Date: ' + new Date(base + (i * 5 + j) * 60 * 1000).toUTCString(),
        'Message-ID: ' + msgId,
        'Content-Type: text/plain; charset=UTF-8'
      ];
      if (prevId) headers.push('In-Reply-To: ' + prevId, 'References: ' + prevId);
      var raw = Utilities.base64EncodeWebSafe(headers.join('\r\n') + '\r\n\r\n' + m.body, Utilities.Charset.UTF_8);
      var resource = { raw: raw, labelIds: m.isMine ? ['SENT'] : ['INBOX', 'UNREAD'] };
      if (threadId) resource.threadId = threadId;
      var inserted = Gmail.Users.Messages.insert(resource, 'me');
      threadId = inserted.threadId;
      prevId = msgId;
    });
  });
  SpreadsheetApp.getActiveSpreadsheet().toast('10 demo emails added to the inbox.', 'Quote Assistant', 5);
}
