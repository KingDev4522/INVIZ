# Release Record — v0.0.2 (frontend/backend split)

Date: 2026-10-05. Structural release: strict `frontend/` + `backend/` +
`shared/` separation per the architecture directive (fulfils PRD 5 §47 —
client credentials are no longer a storage strategy at all).
`releases/inviz-0.0.2.zip` (extension artifact, reproducible — rebuild any time
with `npm run build --workspace=frontend`; `releases/` is git-ignored by design).

## R1 — All phase exits green (re-verified after the split)

| Phase | Exit evidence |
|---|---|
| 0 Foundations | typecheck clean, 17/17 tests, loadable `dist/`, secrets clean |
| 1 ContextLens | +18 tests (accname, registry, triggers, quota), zero-network proof by grep |
| 2 Audio | +18 tests (controller, TTS shape, chunking, routing), speech repin verified |
| 3 Voice | +24 tests (VAD, tagging, turn manager, Whisper contract) |
| 4 Gateway+Qwen | +34 tests (pool, validator, budgets, Q&A grounding, enrichment) |
| 5 Agent | +36 tests (controller flows, WebGuard, confirmation, verification) |
| 6 Security | +21 tests (canaries, 16-case suite); `docs/audit-note.md` published |
| 7 Demo readiness | +9 qualification tests; `demo-scripts.md`, `slo-report.md` (honest pending split) |
| **Total** | **177/177 green, typecheck clean, secrets clean** |

## R2 — Zero secrets in repo (boundary enforced by test)

`npm run scan-secrets`: clean (test canaries allowlisted by design; backend
`.env` files skipped as local-only). Additionally, `frontend` carries an
executable architecture test (`architecture-boundary.test.ts`) proving zero
provider keys, endpoints, or credential names in any browser-controlled file.
No keys, tokens, or credentials exist anywhere in tracked files.

## R3 — Docs versioned

PRDs 1–5 carry `**Version:** 1.0 | **Date:** 2026-10-05 | **Status:** Authoritative`
headers. PRD 6 master is v1.1 (changelogged); PRDs 6.0–6.8 are v1.0 with closing
lines. This release record pins the set.

## R4 — License: DEFERRED (owner decision pending)

No license file ships. `package.json` declares `UNLICENSED` to prevent accidental
publishing. The owner chooses the license before any distribution.

## R5 — Product name: INVIZ (owner-decided, final)

Shipping identifiers use `INVIZ` (manifest `name`, popup, options, README, docs);
artifact is `releases/inviz-0.0.1.zip` (reproducible — rebuild any time with
`npm run build`; `releases/` is git-ignored by design). ContextLens + VoiceLens
remain as internal component names (page understanding + voice interaction).

## Packaging

- `releases/inviz-0.0.2.zip`: load-unpacked artifact (`frontend/dist/`), built from the
  tagged tree state recorded here (rebuilt + re-verified on every release pass).
- `docs/credential-guide.md`: non-technical key setup (no gcloud required).
- `docs/quick-start.md`: bilingual shortcut/earcon card.
- `docs/permission-review.md`: 4-permission manifest (`storage, tabs, commands,
  offscreen`); `scripting` + `activeTab` removed as unused; no `<all_urls>`.

## Known live pendings (NOT waived, NOT hidden)

C2 speech model terms acceptance in the Groq console → one-time account step →
audible AI-voice TTS proofs (Hindi speaks with an English-accented voice; the
voice is English-only) · C1 Groq keys → backend `.env` → live mic/agent proofs ·
backup videos + credential-validation record (Phase 7 exits 4–5) · license
sign-off above. Nothing here is presented as done; see `docs/slo-report.md` for
the measured-vs-pending split. Real-site qualification slots remain open for
Phase 7; test-page/ is the qualified development target.
