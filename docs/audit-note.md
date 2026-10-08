# Security & Privacy Audit Note

Completed in Phase 6 (PRD 6.6), verified by `npm test` (168/168 green, 2026-10-05).
Readable by a non-author engineer in 15 minutes.

## 1. What is trusted (and why)

| Source | Trust level | Basis (enforced where) |
|---|---|---|
| System policy + WebGuard rules | Highest | Shipped deterministic code (`webguard/policy.ts`); no model calls inside |
| Explicit user speech (intent) | High for intent | Directly from the user; never overrides platform/security restrictions (controller `routeVoice`) |
| Verified browser state | High for facts | Observed from the live DOM + `VERIFIED_*` verdicts only (`verification-engine.ts`) |
| Qwen interpretation | Advisory only | Output-contract validator; Layer B carries `MODEL_INFERENCE` provenance and can never authorize |
| Raw page content | Untrusted | Always: provenance-tagged at serialization, never an authorization source |

## 2. Where secrets live

Category C values (passwords, OTP, CVV, card numbers, tokens): **runtime memory only** —
Agent Controller secret map → WebGuard metadata validation → Executor → DOM → envelope
zeroed immediately after the action object is built.

Never in: Qwen context (slot-fill bypasses reasoning), Layer A/B (states only, values
structurally absent), TaskState snapshots (no secret fields by type), logs (redact-at-emission),
telemetry (metadata + redaction), TTS (fixed sensitive template; model reasons never spoken
for sensitive targets), any storage area (memory-only rule tested).

Canary-leak suite (`src/security/canary.test.ts`): passwords/OTP/card canaries driven
through the real fill flow — zero occurrences in snapshots, model payloads, logs,
telemetry, speech builders, and TTS request shapes. PASS.

## 3. Failure behavior per class

| Failure | Behavior (tested) |
|---|---|
| AI unavailable | Honest speech + deterministic accessibility mode (`AI_SERVICE_UNAVAILABLE`) |
| Verification failure | Re-observe new state → reassess → bounded recovery (1+3 max), never blind replay; then honest FAILED speech |
| Stale target | Rejected at registry + guard (`STALE_TARGET`); fresh reasoning required |
| Pending confirmation timeout (90s) | Rejected, fail closed; question timeouts re-run instead of answering late |
| Restart mid-task | In-flight task CANCELLED with partial state preserved; pending confirmations/questions cleared, never resumed |
| Unsupported page/section | Explicit "can't access" status (badge + popup + speech path); no workarounds attempted |
| Malformed model output | Rejected at schema gate; never interpreted, never executed |
| Extra-field smuggling (`run`/`eval`/…) | Rejected: action schema is closed (PRD 4 §79) |
| Confirmation riders ("yes, delete everything") | Only the pending action can execute; riders cannot create actions |

## 4. Credential handling

- Groq keys (1..N) in the backend `.env` only, never in the browser. One
  provider serves reasoning, transcription and speech, so there is no second
  credential set. Plain bearer keys — no OAuth, no project ID.
- Never logged (redact-at-emission + key-name blocklist), never transmitted except to
  the provider's own endpoint, never committed (`scan-secrets` gate, clean).
- Rotation: revoke at provider → edit `backend/.env` → restart backend → press
  Validate. No code or config changes involved.
- Known limitations (documented, not hidden):
  - The speech model is English-only, so Devanagari is romanized server-side
    before synthesis. Hindi therefore speaks with an English-accented voice
    rather than a native Hindi one; the browser's local Hindi voice remains the
    fallback when the AI voice is unavailable.
  - The speech model is gated behind a one-time terms acceptance in the Groq
    console. Until accepted, `/v1/tts` answers `503 TTS_TERMS` and the
    extension falls back to `speechSynthesis` instead of failing silently.

## 5. Security suite result

16/16 cases green (`src/security/suite.test.ts` + `canary.test.ts`):
PRD 5 §84 injection-as-answer · §85 stale target · §86 sensitive field ·
§87 explicit-yes confirmation · §88 malformed output · §89 user override ·
§90 AI failure · §91 Layer-B poisoning differential (verdicts never weaken) ·
§92 malicious ARIA (forces confirmation, never auto-executes) · §93 sensitive
telemetry redaction · §94 restricted surfaces fail closed · upload/download
inexpressible (no such action types) · navigation scheme denylist ·
confirmation-bypass claims · loop-pump bound (4 max) · restart-resume attack ·
rider confinement.

## 6. Findings fixed during this phase (not hidden)

1. Confirmation speech echoed model text verbatim — a model-echoed secret would
   have been spoken AND persisted. Now: fixed template for sensitive targets;
   stored summaries are the sanitized speech, never raw model text.
2. Action schema accepted unknown extra fields — closed the schema (extra-field
   smuggling now fails validation).
3. `supportOf` lived untestably inside the worker — extracted to
   `src/shared/page-support.ts` with full surface coverage.
