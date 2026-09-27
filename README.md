# freight-quote-drafts

A Google Apps Script for small US freight brokers. Every 5 minutes it reads new
rate requests in a shared inbox (quotes@, info@), pulls out the lane details
with an AI model, looks up what the broker charged on that lane before, and
saves a **draft reply in the same Gmail thread** with the label `Quote ready`.

It never sends anything. A person always opens the draft, checks it, fills in any
`[RATE: ...]` note, and presses Send.

```
new email ──> AI reads it ──> JSON: origin, destination, equipment, weight, pickup date
                                   │
                                   ├─ not a rate request ─> label "Not a quote", no draft
                                   │
                                   └─> "Rate history" sheet ─> draft reply in the thread
                                        exact lane: median of the last 5 loads   + label "Quote ready"
                                        same states only: range, for the broker  + row in "Log" sheet
                                        nothing: [RATE] placeholder
                                        missing details: polite questions in the same draft
```

![Gmail: inbox with labels, then two drafts opened](docs/gmail-flow.gif)

## Want it running on your inbox?

Dmytro sets it up for you, entirely by email: no calls, no meetings.

1. You get a link to a ready Google Sheet with your settings filled in.
2. You click **File → Make a copy**, then **Quote Assistant → Setup** and **Allow**.
3. Drafts start showing up in Gmail. Replace the sample rates with your own when you like.

**You will see "Google hasn't verified this app".** The copy of the script belongs
to you: the "developer" on that screen is your own email address, and the code runs
in your own Google account. Click **Advanced → Go to Quote Assistant (unsafe) →
Select all → Continue**. The script asks only for what it uses: read mail, create
drafts and labels (`gmail.modify`), this one sheet, a 5-minute timer and calls to the
AI service. Google's wording for `gmail.modify` still mentions sending; the code has
no send call, and the tests fail if one appears.

Agencies that set up inboxes for brokers: white-label by agreement.

Write to **dkautomation.lab@gmail.com**.

A live run in a test Gmail account on 26.09.2026: 10 test emails in, 9 drafts
saved in their own threads with the label `Quote ready`, the invoice labelled
`Not a quote`. Nothing was sent.

![Inbox after the run](docs/gmail-inbox.png)

Two lanes in one email: a rate for the lane with history, a `[RATE]` note for the
lane without it.

![Draft for two lanes](docs/gmail-draft-two-lanes.png)

All 10 emails side by side, rendered locally from the recorded model answers
(`node scripts/preview.js`): [`docs/preview.png`](docs/preview.png),
[`docs/preview-hard.png`](docs/preview-hard.png).

## What is verified, and how

| Claim | How | Result |
|---|---|---|
| The model reads all 11 test emails correctly | `scripts/live-eval.js`: real Gemini API, the same prompt the script uses, compared field by field with answers written by hand before the first run | **11/11** on `claude-haiku-4-5` through the deployed proxy (27.09); Gemini 10/10 and 11/11 on earlier prompts — [`docs/live-eval.txt`](docs/live-eval.txt) |
| 40 new emails from a separate author (forwarded load-board posts, multi-stop, ZIP codes only, LTL pallets, hazmat, HTML leftovers, corrections in replies, Spanish, 10/2 dates, carrier offers and invoices) are read correctly | `scripts/stress.js` through the live proxy, answers written by another agent that never saw the prompt | **40/40** whole email correct (first run 36/40; the misses fixed in the prompt and code, see [`docs/stress-report.md`](docs/stress-report.md)) |
| Rates, questions and the reply text are right for each email; US formats (`Fri, Sep 25`, `$1,850`, `44,000 lbs`, `10/2`, `Texas` → `TX`, ZIP is never a city) | `npm test` on the recorded model answers | 29 tests |
| Every quote email gets one draft in its own thread + `Quote ready`; the invoice gets `Not a quote`; nothing is sent | `npm test`: `Main.gs` runs against a fake Gmail API and Sheets where any send, trash or delete throws | 18 tests |
| A Thursday 9:30 PM email in Chicago (Friday 02:30 UTC) is dated Thursday, so "Fri" is the next day | same, with the sheet's time zone | test |
| A second run does not create duplicate drafts or call the model again | same | test |
| Model down (HTTP 503) → no label, logged, retried 5 minutes later; an answer the script cannot read → 3 attempts, then left for a person | same | 3 tests |
| Label fails after the draft is saved → still no second draft | same | test |
| Customer writes again in a thread that already has a draft → a new draft | same | test |
| Busy inbox: 27 requests at once → 20 in the first run (oldest first), 7 in the next | same | test |
| The tests catch real mistakes | broke the equipment check, the "we wrote last" check and the duplicate-draft guard on purpose | each made tests fail |

```bash
npm test          # 61 tests, no network, no Google account
```

**Live run in Gmail (26.09.2026).** A new Gmail account, the three `.gs` files
pasted into a sheet's script, **Setup**, **Load demo emails**, then the
5-minute trigger. Result: 9 drafts, each in its own thread, `Quote ready` on
each, the invoice and two Google notices labelled `Not a quote`. The Sent folder
holds one message: the broker's earlier question from test email 8, put there by
the demo loader, not sent. Running **Check inbox now** again right after created nothing new.

What the live run found that the tests did not:
- `gemini-2.5-flash` answers 404 to a new API key ("no longer available to new
  users"). The default model is now `gemini-flash-latest`.
- A real email with the whole request in the subject and "Hi" in the body was
  skipped as "not a quote": the prompt had only the body. The subject now goes into
  the prompt, and this case is test email 11.
- An evening email in the US is already the next day in UTC, and the prompt used the UTC
  date: "tomorrow" written on Thursday evening became Saturday. Dates are now read in
  the time zone from **Settings**.
- Claude Haiku got the weekday wrong in 3 of 11 emails ("Fri" from a Thursday became
  Saturday). The prompt now carries a 14-day calendar; after that 11/11.
- The free tier answered 503 ("high demand") and 429 (daily limit) during the
  run. The script used to count these as failed attempts and give up on an email
  after 3; now a service error stops the run and the email waits for the next one.

## The 11 test emails

All invented. Addresses use the reserved `example.com/.net/.org` domains, phone numbers are `555-01xx`.

| # | What it tests | Expected result |
|---|---|---|
| 1 | Full request, "pickup Fri" | $1,850, Fri Sep 25 |
| 2 | No weight | $1,425 + asks for the weight |
| 3 | No pickup date | $975 + asks for the date |
| 4 | Two lanes in one email | $725 for one, `[RATE]` for the other |
| 5 | Reefer, no loads on this exact lane | range from similar lanes, for the broker |
| 6 | Flatbed; history has only a dry van on this lane | `[RATE]`, the dry van price is not used |
| 7 | Invoice question, not a rate request | skipped, no draft |
| 8 | Reply in a thread: weight comes in the third message | $675, uses the whole thread |
| 9 | Signature with an address and phone numbers | signature ignored, $825 |
| 10 | "Los Angelas", "San Antonoi", "53 ft van", "44k" | Los Angeles → San Antonio, dry van, 44,000 lbs, $2,950 |
| 11 | Whole request in the subject, body just "Hi" (added after the live run missed exactly this) | Memphis → Dallas, reefer, 30,000 lbs, `[RATE]` |

## The sheet

Four tabs, in this order:

- **Start here** — the three steps above in big type, what the Log colors mean, where to write for help.
- **Rate history** — one row per past load; dates as `9/10/2026`, rates as `$1,850`.
- **Settings** — your name, company, **time zone** (so "Fri" in an evening email is read
  as the customer's Friday, not UTC's), the client token. A hint next to each field.
- **Log** — one row per email, **newest on top**; green = draft ready, grey = not a
  quote, red = needs a look. Times in 12-hour US format.

Headers stay frozen while scrolling. Running **Setup** again on an older copy adds any
new settings and formatting without touching your rows.

## Try it from the source

1. Create a Google Sheet, open **Extensions → Apps Script**.
2. Copy `src/Core.gs`, `src/Main.gs`, `src/DemoData.gs` into three script files.
   In **Project Settings** turn on "Show appsscript.json" and paste `src/appsscript.json`
   (it turns on the Gmail API used to load the demo emails).
3. Reload the sheet: **Quote Assistant → Setup** (asks for a Gemini API key), then
   **Quote Assistant → Load demo emails**. This puts the 10 test emails straight into
   the inbox without sending anything.
4. **Quote Assistant → Check inbox now**, or wait up to 5 minutes.

Use a test Gmail account and invented emails only: the free Gemini tier may use
what you send it to improve Google's products.

The free tier also has a small daily limit: on 26.09.2026 it was 20 requests per
day per model (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). One email is
one request, so a demo run of 10 emails can be repeated about once a day. The
model is set in the **Settings** sheet; each model has its own limit, so switching
to `gemini-flash-lite-latest` gives another 20. `gemini-2.5-flash` is closed to new
API keys ("no longer available to new users", seen 26.09.2026).

When the AI service is busy (HTTP 503) or out of quota (429), the run stops after
that one call and the email is tried again 5 minutes later. Such failures never
count toward the 3 attempts; only an answer the script cannot read does.

## How it is built

- `src/Core.gs` — prompt, reading the model answer, rate lookup, reply text. No Google services, so it runs in Node tests as is.
- `src/Main.gs` — menu, setup, the 5-minute trigger, Gmail and Sheets.
- Gmail goes through the Gmail API (advanced service) with `gmail.modify`, not `GmailApp`, which would ask for full mail access including permanent deletion.
- `callModel()` in `Main.gs` is the only place that talks to the AI. To move to a proxy or another provider, change that one function.
- `test/gas.js` loads the `.gs` files into one shared scope, the way Apps Script does.

## quote-proxy: the paid setup

In the demo the sheet calls Gemini with its own key. For a paying broker the sheet
holds only a **client token**; `callModel()` sends the prompt to `quote-proxy`, a
Cloudflare Worker ([`proxy/`](proxy)) that holds the AI key and decides whether to
answer.

```
sheet (Client token) ──{prompt}──> quote-proxy ──> Gemini or Claude
                                     │ unknown token        → 401
                                     │ paused by me         → 403 "service paused - contact Dmytro"
                                     │ paid_until passed    → 402 same message
                                     │ client's daily limit → 429 same message
                                     │ all clients' limit   → 503 same message
```

The sheet treats every refusal like a busy AI: no draft, the message goes to the
**Log** sheet, the email is tried again on the next run.

- The AI key is a Worker secret (`wrangler secret put AI_KEY`). Clients never see it.
- KV keeps token hashes, client settings and daily counters. Email text is never
  logged or stored: a test sends a marked prompt through success, provider failure
  and a bad token, and fails if the marker shows up in console output, KV or any reply.
- `PROVIDER = "gemini"` (free, tests) or `"anthropic"` (`claude-haiku-4-5`), one variable.
- Clients are managed from the command line, no web page:

```bash
node proxy/admin.js add "Acme Freight" 200 2026-10-31   # prints the token once
node proxy/admin.js pause "Acme Freight"
node proxy/admin.js list
node proxy/admin.js push                                # prints the upload command
```

**What a runaway client can cost.** The worst request the proxy accepts is a
20,000-character prompt (about 5,000 tokens, the Worker refuses anything longer) with
the full 1,024-token answer. At Claude Haiku 4.5 prices ($1 per million input tokens,
$5 per million output) that is about $0.005 + $0.005 = **$0.01 per request**. With the
default limit of 100 requests a day, **one client costs at most about $1 a day**.
A typical email is far smaller: the prompt is about 1,700 characters and the answer
about 150 tokens, roughly $0.0013.

All clients together are capped at the sum of the daily limits of enabled, paid
clients plus 10% (the KV counters are not atomic, so two requests in the same instant
can both take the last slot), and never above `GLOBAL_DAILY_LIMIT`. When client A
uses up its day, client B keeps working: a test checks exactly that.

Before switching `PROVIDER` to `anthropic`: set a monthly spend limit in the
Anthropic Console and keep auto-reload off, so a bug can stop the service but cannot
run up a bill.

Checked: 14 proxy tests (every guard also broken on purpose to see its test fail).
Live at `https://quote-proxy.dkautomation.workers.dev` since 27.09.2026 with
`claude-haiku-4-5`.

## What the AI sees

The text of the last few messages in the thread, without quoted replies.
No sheet data, no attachments, no other emails. The rate history stays in the sheet.

## Limits

- The rate is a lookup of what you charged before, not a market rate. Lanes with no history get a `[RATE]` placeholder.
- Cities are matched by name. "Dallas" and "Fort Worth" are different lanes.
- Up to 20 new emails per run, 7 seconds apart, to stay inside the free Gemini limits. More wait for the next run.
- Only the last 2 days of the inbox are checked.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to read, run and change for
noncommercial use. Commercial use and installing it for your own business: write to
the author, dkautomation.lab@gmail.com.
