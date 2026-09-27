# Stress test: 40 broker-inbox emails through the live proxy

Run 2026-09-27 11:51 UTC, model claude-haiku-4-5 via quote-proxy, time zone America/Chicago.
Emails and expected answers written by a separate agent that never saw the prompt (`test/stress/emails.json`);
raw model answers in `test/stress/answers.json`. Rerun: `node scripts/stress.js <token-file>`.

**Whole email correct: 40/40 (100%)** — every field of every lane, plus quote / not-quote.

| Field | Correct | % |
|---|---|---|
| quote | 40/40 | 100% |
| lanes | 34/34 | 100% |
| o | 34/34 | 100% |
| d | 34/34 | 100% |
| eq | 34/34 | 100% |
| w | 34/34 | 100% |
| date | 34/34 | 100% |

Lane fields are scored only for emails where the lane count matched.

| Category | Whole email correct |
|---|---|
| plain | 5/5 |
| forwarded-loadboard | 3/3 |
| multi-stop | 3/3 |
| zip-codes | 4/4 |
| asap | 2/2 |
| pallets-ltl | 3/3 |
| hazmat | 2/2 |
| html-ish | 2/2 |
| reply-thread | 4/4 |
| not-quote | 5/5 |
| spanish | 2/2 |
| mmdd-date | 2/2 |
| subject-only | 1/1 |
| messy-weights | 2/2 |

## Misses

None.
## History

- **Run 1 (10:02 UTC): 36/40 (90%)**, below the >90% bar. Misses: `s17`, `s18`, `s20` — equipment
  not stated, or LTL / box truck, and the model filled in "dry van" instead of leaving it for a
  question; `s37` — "Saint Louis" where rate sheets and the expected answer say "St. Louis".
- Fixes: the prompt says equipment only when the customer asked for it (LTL, box truck, step deck,
  tanker, power only, not mentioned: null, the draft asks); city names starting with "Saint" / "St"
  become "St. " in the draft and in the rate lookup. A regression test for each.
- Two expected dates in the fixtures were corrected before run 1 was scored: `s20` "next Monday"
  and `s35` "próximo martes" sent on Wednesday 9/23 are 9/28 and 9/29 (the author had counted two
  weeks ahead, against its own spec).
- **Run 2 (11:51 UTC): 40/40.** Cost of both runs: 81 requests on Claude Haiku 4.5, about $0.10.
- After run 2 the fixture signatures were moved to reserved ranges (`*.example.com`, 555-01xx phones) for the public repo; lane text unchanged.
