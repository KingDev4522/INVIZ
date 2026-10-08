# Site Qualification Record

Authoritative checklist: PRD 6 §9. One section per candidate site, completed in Phase 7 (PRD 6.7 §1.1).
No site is demoed until all six items PASS (or a scoped-content rule is owner-accepted).

## Qualified baseline: test-page/ fixture site (local)

Served via `npm run test-page` at `http://127.0.0.1:8080/`.
Evidence: executable suite `test-page/site-qualification.test.ts` (9/9 green) running the
REAL extraction pipeline over the REAL fixture markup.

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | Injectable task-path pages | Manifest matcher covers `http://127.0.0.1:8080/*` + `http://localhost:8080/*`; no `<all_urls>` | PASS (static; live heartbeat at demo) |
| 2 | No cross-origin iframe / closed-shadow targets on the path | 0 `iframe/frame/embed/object`, 0 shadow hosts in fixture markup | PASS |
| 3 | No CAPTCHA / OTP-gated login / payment inside the scripted path | No captcha/payment markup; OTP field exists but is excluded by scoped rule below | PASS with scoped rule |
| 4 | Stable accessible names across reloads | Static markup + static result literals; 3-parse name diff = identical | PASS (static; live reload diff at demo) |
| 5 | `aria-busy` regions settle within verification budgets | All `setTimeout` delays in `app.js` ≤1200ms < 3000ms default budget; `aria-busy` regions present | PASS |
| 6 | Layer A weight fits 1MB per-tab cap with headroom | Measured registry snapshot serialization « 100KB internal bar (10x under cap) | PASS |

Demo-readiness extras (same suite): every interactive on task paths has a non-empty
accessible name; all required fields are label-associated; modal is a real `<dialog>`
with open + close controls.

Scoped-content rules: **OTP field excluded from both demo scripts** (reserved for
sensitive-path/security testing). Demo B uses ordinary fields only (name/email/phone).

## Candidate slot 2: _(owner pick pending)_

Status: OPEN. Qualify with the same 6-item procedure before any demo use.

## Candidate slot 3: _(owner pick pending)_

Status: OPEN. Qualify with the same 6-item procedure before any demo use.
