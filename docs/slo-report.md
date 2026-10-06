# SLO Measurement Report (PRD 6.7 §1.3, PRD 6 §10)

Broadband desktop Chrome. Two evidence classes, kept strictly separate:
**MEASURED** (executable today, cited) vs **LIVE-PENDING** (needs browser session
+ C1/C2 keys). A pending item is not a pass; misses, when measured, are filed
as Phase 1–5 defects — never silently accepted.

## MEASURED (suite-backed, 2026-10-05)

| SLO / requirement | Evidence | Result |
|---|---|---|
| Malformed model output 100% rejected | `response-validator.test.ts` hostile corpus (smuggling, invented IDs, bad types) | PASS |
| Validator + policy zero-trust on hostile ARIA/names | `suite.test.ts` poisoning differential + monotonicity | PASS |
| 16/16 security cases | `suite.test.ts` + `canary.test.ts` | PASS |
| Action budget 25 → LIMIT_REACHED | `controller.test.ts` budget test (exactly 25, then stop) | PASS |
| Recovery bound 1+3 → FAILED | controller + suite loop-pump tests (exactly 4 executes) | PASS |
| Dedupe: rapid-Tab never stacks identical speech | `audio-controller.test.ts` (in-flight + queued + history) | PASS |
| Chunking: 12KB reads complete in order, byte-safe | `tts.test.ts` (incl. Devanagari no-split) | PASS |
| Layer A ≤1MB cap with cut-log | `phase1.test.ts` quota test + `site-qualification.test.ts` weight check | PASS |
| Bilingual contracts (confirmation sets, tagging, templates, TTS routing) | `confirmation.test.ts`, `transcript.test.ts`, `focus`/`tts`/`controller` tests EN+HI | PASS |
| No secrets in repo | `scan-secrets` | PASS (clean) |

## LIVE-PENDING (procedure defined, awaiting C1 + C2 + browser)

| SLO | Procedure | Status |
|---|---|---|
| Focus → first audio ≤800ms p95 (100 Tabs, warm + cold cache) | Load unpacked → test-page → scripted Tab walk with performance marks; report warm/cold separately | PENDING |
| Capture stop → transcript ≤2.5s (≤15s audio) | 30 timed captures across EN/HI/Hinglish | PENDING |
| Voice command → spoken ack/question ≤4s | 20 commands timed to first audio | PENDING |
| Action → verification verdict ≤5s (local DOM) | 20 actions on fixture (excl. site latency) | PENDING |
| Demo A + B pass 5/5 ×2, EN+HI | `docs/demo-scripts.md` rehearsal log | PENDING |
| Bilingual audible matrix (voices, mirroring, earcons) | Native-speaker listening pass, 30 samples | PENDING |
| Mic loopback self-talk (zero self-transcription, 10s full-volume) | Armed mic + system speech, transcript log must be empty | PENDING |

## Defects filed from this run

None — every measurable item passes. Live items will either pass or arrive here
as Phase 1–5 defects with fixes and re-measurement before any demo-day claim.
