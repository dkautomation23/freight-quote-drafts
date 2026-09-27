// Gmail + Sheets side. Creates drafts only: nothing in this project sends email.

var LABEL_READY = 'Quote ready';
var LABEL_SKIPPED = 'Not a quote';
var SHEET_RATES = 'Rate history';
var SHEET_LOG = 'Log';
var SHEET_SETTINGS = 'Settings';
var SHEET_START = 'Start here';
var LOG_HEADERS = ['Time', 'Message ID', 'From', 'Subject', 'Result', 'Lanes', 'Rates', 'Missing', 'Error'];
var THREADS_TO_SCAN = 100;    // already handled threads are cheap: no model call
// Set when quote-proxy is deployed. With a Client token in Settings, AI calls go here instead of Gemini.
var PROXY_URL = 'https://quote-proxy.dkautomation.workers.dev/';
var LOG_ROWS_TO_READ = 3000; // newest first; the inbox search covers 2 days, so older Log rows never matter for de-duplication
var MAX_ATTEMPTS = 3;          // an email the AI cannot read is retried twice, then left for a person
var MAX_MODEL_CALLS_PER_RUN = 20; // with the 7 s pause, well inside the 6-minute Apps Script limit
var LOCAL_TIME_PATTERN = 'yyyy-MM-dd h:mm a';
var MISSING_LABEL = { origin: 'pickup city', destination: 'delivery city', equipment: 'equipment', weight_lbs: 'weight', pickup_date: 'pickup date' };

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
  ensureSheet(ss, SHEET_SETTINGS, ['Setting', 'Value', 'What to put here'], []);
  ensureSheet(ss, SHEET_LOG, LOG_HEADERS, []);
  ensureSettings(ss);
  styleSheets(ss);
  labelId(LABEL_READY);
  labelId(LABEL_SKIPPED);

  var props = PropertiesService.getScriptProperties();
  if (!readSettings(ss).clientToken && !props.getProperty('GEMINI_API_KEY')) {
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

// [name, default, hint]. Setup adds rows a copy is missing, so older copies pick up new settings.
function settingRows(ss) {
  return [
    ['Your name', DEMO_BROKER, 'Signed under every draft.'],
    ['Company name', DEMO_COMPANY, 'Second line of the signature.'],
    ['Time zone', ss.getSpreadsheetTimeZone(), 'Your office time zone, e.g. America/Chicago or America/New_York. "Fri" and "tomorrow" in emails are read in this zone.'],
    ['Client token', '', 'Filled in by Dmytro during setup. Leave as is.'],
    ['Model', 'gemini-flash-latest', 'Only for the free demo without a client token.']
  ];
}

function ensureSettings(ss) {
  var sh = ss.getSheetByName(SHEET_SETTINGS);
  sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What to put here']]);
  var have = sh.getDataRange().getValues().map(function (r) { return r[0]; });
  settingRows(ss).forEach(function (s) {
    var at = have.indexOf(s[0]);
    if (at < 0) { sh.appendRow(s); have.push(s[0]); } else sh.getRange(at + 1, 3, 1, 1).setValues([[s[2]]]);
  });
}

// Formatting only, safe to re-run: frozen headers, US number formats, status colors, a Start here tab first.
function styleSheets(ss) {
  var start = ss.getSheetByName(SHEET_START) || ss.insertSheet(SHEET_START, 0);
  start.clear();
  var text = [
    ['Quote Assistant', '', ''],
    ['Reads rate requests in this Gmail inbox and writes reply drafts with your rates. It never sends anything.', '', ''],
    ['', '', ''],
    ['1', 'Add your past loads to Rate history', 'One row per load: date, cities, states, equipment, rate. More loads = more drafts with a ready price.'],
    ['2', 'Check Settings', 'Your name, company and time zone. The client token is already filled in.'],
    ['3', 'Menu Quote Assistant > Setup, then click Allow', 'The inbox is checked every 5 minutes. Drafts wait in Gmail > Drafts with the label "Quote ready".'],
    ['', '', ''],
    ['Log', 'One row per email, newest on top', 'Green = draft ready. Grey = not a quote. Red = needs a look.'],
    ['Help', 'dkautomation.lab@gmail.com', 'Setup, changes and questions by email.']
  ];
  start.getRange(1, 1, text.length, 3).setValues(text).setWrap(true).setVerticalAlignment('middle');
  start.getRange(1, 1, 1, 3).merge(); // title and subtitle span the page, not the narrow step-number column
  start.getRange(2, 1, 1, 3).merge();
  start.getRange(1, 1).setFontSize(22).setFontWeight('bold');
  start.getRange(2, 1).setFontSize(12).setFontColor('#555555');
  start.getRange(4, 1, 3, 1).setFontSize(28).setFontWeight('bold').setFontColor('#1a73e8').setHorizontalAlignment('center');
  start.getRange(4, 2, 3, 1).setFontSize(14).setFontWeight('bold');
  start.getRange(4, 3, 3, 1).setFontSize(11);
  start.getRange(8, 1, 2, 1).setFontWeight('bold');
  start.setColumnWidth(1, 70).setColumnWidth(2, 380).setColumnWidth(3, 560);
  start.setRowHeights(4, 3, 64);
  start.setHiddenGridlines(true);
  start.setTabColor('#1a73e8');

  var rates = ss.getSheetByName(SHEET_RATES);
  rates.getRange('A:A').setNumberFormat('M/d/yyyy');
  rates.getRange('G:G').setNumberFormat('$#,##0');
  var settings = ss.getSheetByName(SHEET_SETTINGS);
  settings.setColumnWidth(1, 140).setColumnWidth(2, 260).setColumnWidth(3, 560);
  settings.getRange('C:C').setFontColor('#666666').setWrap(true);
  var log = ss.getSheetByName(SHEET_LOG);
  log.getRange('A:A').setNumberFormat('M/d/yyyy h:mm AM/PM');
  var result = log.getRange('E2:E');
  var color = function (prefix, bg) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith(prefix).setBackground(bg).setRanges([result]).build();
  };
  log.setConditionalFormatRules([color('draft', '#d9ead3'), color('skipped', '#eeeeee'), color('error', '#f4cccc')]);

  [rates, settings, log].forEach(function (sh) {
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#f1f3f4');
  });
  ss.setActiveSheet(start);
  ss.moveActiveSheet(1);
}

function readSettings(ss) {
  var out = { signerName: '', companyName: '', model: 'gemini-flash-latest', clientToken: '', timeZone: '' };
  var sh = ss.getSheetByName(SHEET_SETTINGS);
  if (sh) sh.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0] === 'Your name') out.signerName = String(r[1]);
    if (r[0] === 'Company name') out.companyName = String(r[1]);
    if (r[0] === 'Model' && r[1]) out.model = String(r[1]);
    if (r[0] === 'Client token') out.clientToken = String(r[1]).trim();
    if (r[0] === 'Time zone') out.timeZone = String(r[1]).trim();
  });
  out.timeZone = out.timeZone || ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  return out;
}

// The only function that talks to the AI: through quote-proxy when the sheet has a client token
// (the paid setup, the AI key stays on the proxy), otherwise straight to Gemini (the demo).
function callModel(prompt, settings) {
  if (settings.clientToken) return callProxy(prompt, settings.clientToken);
  var model = settings.model;
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

// HTTP errors from the AI (busy, quota, model retired) are about the service, not the email.
function isServiceError(message) {
  return /^model http /.test(String(message || ''));
}

// Errors keep the "model http" prefix so a paused client or a busy AI stops the run and retries later;
// the proxy's message ("service paused - contact Dmytro") lands in the Log as is.
function callProxy(prompt, token) {
  if (!PROXY_URL) throw new Error('model http 0: PROXY_URL is not set in the script');
  var res = UrlFetchApp.fetch(PROXY_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-client-token': token },
    muteHttpExceptions: true,
    payload: JSON.stringify({ prompt: prompt })
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (res.getResponseCode() !== 200) throw new Error('model http ' + res.getResponseCode() + ': ' + (body.error || 'proxy error'));
  return String(body.text || '');
}

// Gmail goes through the Gmail API (advanced service) with the gmail.modify scope only: read, drafts,
// labels. GmailApp would ask for full mail access ("send and permanently delete"), which this never needs.
function labelId(name) {
  var found = (Gmail.Users.Labels.list('me').labels || []).filter(function (l) { return l.name === name; })[0];
  return found ? found.id : Gmail.Users.Labels.create({ name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me').id;
}

function myAddress() {
  return Gmail.Users.getProfile('me').emailAddress.toLowerCase();
}

function header(msg, name) {
  var h = (msg.payload.headers || []).filter(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })[0];
  return h ? h.value : '';
}

// The text/plain part if there is one, otherwise the HTML part without tags.
function plainBody(payload) {
  var decode = function (p) { return Utilities.newBlob(Utilities.base64DecodeWebSafe(p.body.data)).getDataAsString('UTF-8'); };
  var find = function (p, type) {
    if (p.mimeType === type && p.body && p.body.data) return p;
    for (var i = 0; i < (p.parts || []).length; i++) { var f = find(p.parts[i], type); if (f) return f; }
    return null;
  };
  var text = find(payload, 'text/plain');
  if (text) return decode(text);
  var html = find(payload, 'text/html');
  return html ? decode(html).replace(/<br\s*\/?>|<\/p>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : '';
}

// "local" is the send time in the broker's zone: the model reads "Fri" and "tomorrow" from it.
function toPlainMessages(apiMessages, myEmail, timeZone) {
  return apiMessages.map(function (m) {
    var from = header(m, 'From');
    var date = new Date(Number(m.internalDate));
    return {
      from: from,
      date: date.toISOString(),
      local: Utilities.formatDate(date, timeZone, LOCAL_TIME_PATTERN),
      body: plainBody(m.payload),
      isMine: from.toLowerCase().indexOf(myEmail) >= 0
    };
  });
}

// A draft in the same thread: threadId plus In-Reply-To/References and the same subject, as Gmail requires.
function createDraftReply(threadId, last, subject, body) {
  var msgId = header(last, 'Message-ID');
  var refs = (header(last, 'References') + ' ' + msgId).trim();
  var mime = [
    'To: ' + (header(last, 'Reply-To') || header(last, 'From')),
    'Subject: ' + (/^re:/i.test(subject) ? subject : 'Re: ' + subject),
    'In-Reply-To: ' + msgId,
    'References: ' + refs,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body
  ].join('\r\n');
  Gmail.Users.Drafts.create({ message: { threadId: threadId, raw: Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8) } }, 'me');
}

function addLabel(threadId, id) {
  Gmail.Users.Threads.modify({ addLabelIds: [id] }, 'me', threadId);
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
    var n = Math.min(logSheet.getLastRow() - 1, LOG_ROWS_TO_READ); // newest rows are on top
    var logRows = n > 0 ? logSheet.getRange(2, 1, n, LOG_HEADERS.length).getValues() : [];
    logRows.forEach(function (r) {
      if (r[4] !== 'error') done[r[1]] = true;
      else if (isServiceError(r[8])) return; // the AI service was down or busy: not this email's fault, retry
      else if ((errors[r[1]] = (errors[r[1]] || 0) + 1) >= MAX_ATTEMPTS) done[r[1]] = true; // give up, stays in Log
    });
    var myEmail = myAddress();
    var ready = labelId(LABEL_READY);
    var skipped = labelId(LABEL_SKIPPED);

    var found = Gmail.Users.Threads.list('me', { q: 'in:inbox newer_than:2d', maxResults: THREADS_TO_SCAN }).threads || [];
    var modelCalls = 0, serviceDown = false;
    found.reverse().forEach(function (t) { // oldest first
      if (serviceDown || modelCalls >= MAX_MODEL_CALLS_PER_RUN) return; // the rest wait for the next run
      var thread = Gmail.Users.Threads.get('me', t.id, { format: 'full' });
      var msgs = thread.messages.filter(function (m) { return (m.labelIds || []).indexOf('DRAFT') < 0; });
      var last = msgs[msgs.length - 1];
      if (!last || done[last.id]) return;
      var plain = toPlainMessages(msgs, myEmail, settings.timeZone);
      if (plain[plain.length - 1].isMine) return; // we wrote last: nothing to answer
      var subject = header(msgs[0], 'Subject');

      var row = [new Date(), last.id, header(last, 'From'), subject, '', '', '', '', ''];
      try {
        modelCalls++;
        var modelText = callModel(buildPrompt(plain, subject), settings);
        Utilities.sleep(7000); // stay under the free Gemini tier's per-minute limit
        var plan = planReply(plain, modelText, rateRows, settings);
        if (plan.action === 'skip') {
          addLabel(t.id, skipped);
          row[4] = 'skipped: not a quote';
        } else {
          createDraftReply(t.id, last, subject, plan.body);
          row[4] = 'draft'; // set before anything else can fail: a draft must never be created twice
          row[5] = plan.items.map(function (it) { return laneTitle(it.lane); }).join('; ');
          row[6] = plan.items.map(function (it) { return it.quote.kind === 'exact' ? money(it.quote.rate) : it.quote.kind; }).join('; ');
          row[7] = plan.items.map(function (it) { return it.lane.missing.map(function (f) { return MISSING_LABEL[f]; }).join(', '); }).filter(String).join('; ');
          addLabel(t.id, ready);
        }
      } catch (e) {
        if (row[4] !== 'draft') row[4] = 'error';
        row[8] = String(e.message || e).slice(0, 300);
        if (isServiceError(row[8])) serviceDown = true; // one failed call per run, not twenty
      }
      logSheet.insertRowBefore(2); // newest on top: the broker sees today's emails first
      logSheet.getRange(2, 1, 1, row.length).setValues([row]);
      done[last.id] = true;
    });
  } finally {
    lock.releaseLock();
  }
}

// Puts the 10 invented emails straight into this inbox (Gmail API insert: nothing is sent).
// Needs the Gmail advanced service, enabled in appsscript.json.
function loadDemoEmails() {
  var me = myAddress();
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
