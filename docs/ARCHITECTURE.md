# INVIZ — Architecture & Logic

> One-page map of what this system is, how it thinks, and how a voice command
> becomes browser action. Written from the code as it stands (v0.0.2).
> Vision: an agentic browsing assistant that lets blind users operate the
> internet by voice — the agent sees the page (accessibility snapshot),
> narrates what it does (local speech), and asks before anything consequential.

---

## 1. The 30-second model

```
Voice ("open YouTube and play lofi")
  → mic capture (offscreen doc) → Whisper STT (backend /v1/transcribe, Groq)
  → service worker routes transcript → AgentController task loop:
       snapshot page → reason (backend /v1/chat) → guard → execute →
       verify → snapshot … until task_complete / confirm / fail
  → every step narrated aloud (browser speechSynthesis, local, zero quota)
```

Two processes, one contract:

| Piece | What it is | Where |
|---|---|---|
| `frontend/` | Chrome MV3 extension. Sees pages, speaks, executes clicks. Holds **zero** provider keys. | `frontend/src/` → built to `frontend/dist/` (load unpacked) |
| `backend/` | Plain-Node HTTP AI gateway on `http://127.0.0.1:8787`. Owns **all** provider keys. Never ships them to the frontend. | `backend/src/` → built to `backend/dist/` |
| `shared/` | Versioned contracts both sides import (actions, validation, messages, constants). | `shared/*.ts` |
| `scripts/` | Ops: `start-backend.ps1`, `scan-secrets.js`, `serve-test-page.js` | `scripts/` |

Golden rule: **the frontend never calls Groq/OpenRouter/Tavily/Ollama.** It only
calls the backend (`/v1/chat|enrich|transcribe|tts|search|validation|health`).
All keys live in `backend/.env` (git-ignored, secret-scan-skipped).

---

## 2. Backend — the brain (`backend/src/`)

Entry: `server.ts` — zero-dependency `node:http` server, CORS + optional
`Authorization: Bearer <BACKEND_TOKEN>`, JSON bodies only.

### 2.1 Routes

| Method + path | Handler | Does |
|---|---|---|
| `GET /v1/health` | `routes/health.ts` | Open. Capability counts only (key counts, model IDs, timestamp). No secrets. |
| `POST /v1/chat` | `routes/chat.ts` | Interactive reasoning → validated `AgentOutcome`. |
| `POST /v1/enrich` | `routes/enrich.ts` → `ai/enrichment.ts` | Advisory page summary (Layer B, `MODEL_INFERENCE` provenance — never authorization). |
| `POST /v1/transcribe` | `routes/transcribe.ts` → `whisper/` | Groq Whisper STT. Base64 audio in JSON (≤ ~5 MB / 60 s capture). |
| `POST /v1/tts` | `routes/tts.ts` → `tts/groq-tts.js` | Groq `canopylabs/orpheus-v1-english` synthesis → base64 WAV. Exists for compat + validation; the extension's voice **does not call it** (local speech, §3.5). |
| `POST /v1/search` | `routes/search.ts` → `search/` | Tavily web search. Query capped (400 chars), results truncated server-side (credits cost money). |
| `POST /v1/validation` | `routes/health.ts` | Live smoke checks (see §2.4). Powers the Options-page "Validate backend (live)" button. |

### 2.2 Configuration (`config.ts`, `backend/.env`)

| Env | Role |
|---|---|
| `GROQ_API_KEYS` (1..N, required) | Reasoning pool + Whisper + (compat) TTS. Pool = round-robin distribution of rate limits. |
| `OPENROUTER_API_KEY` (optional) | Second reasoning vendor (chat + enrich only). Absent = Groq-only cloud reasoning. |
| `OPENROUTER_MODEL` | Chat-completions model returning JSON-only outcomes (default `google/gemma-4-26b-a4b-it:free`). |
| `TAVILY_API_KEY` (required) | Web search. Required because search is a core capability. |
| `OLLAMA_URL` / `OLLAMA_MODEL` (optional) | Local reasoning (additive, **preferred**). Intended model: `qwen3.5:9b-q4_K_M` — the tag must match `ollama list` exactly. Empty/`disabled` = cloud-only. Known constraints on the pinned build: structured output uses `format="json"` (not json-schema) and `think=false` is always sent. |
| `LLM_PROVIDER` | `auto` (local-first: ollama → openrouter → groq) or pinned (`groq` = cloud-first). `auto` and `ollama` are both local-first; currently pinned to `ollama` in `backend/.env`. |
| `OLLAMA_KEEP_ALIVE` / `OLLAMA_TIMEOUT_MS` | Keep weights resident (`30m`); 180 s bounded budget so a cold load is never mistaken for a dead endpoint. |
| `PORT` / `BACKEND_TOKEN` | `8787`; empty token = loopback-dev only. |

`loadConfig()` throws on missing keys with **value-free** messages; `configSummary()`
logs counts/presence only — values never appear in logs.

### 2.3 Reasoning core (`ai/qwen-client.ts`)

- `reasonOnce(input)` = one reasoning operation: picks providers, loops
  primary → fallback, enforces the **output contract** (`shared/response-validator.ts`):
  exactly one JSON outcome (`answer | action | confirmation_required |
  task_complete`), with a **single corrective re-ask** on malformed replies.
- Provider order (`reasoningOrder`): pinned provider first, else local → cloud
  standby chain. **Never rotation** — a healthy provider ends the request, so
  normal turns spend no standby quota.
- Latches (per process, reset on restart): OpenRouter 401/403 → suspended for
  the process lifetime. **Ollama is different — its suspension is BOUNDED**, so
  a temporary local outage is self-healing:
  - transient (`network` / `timeout`) → suspended for
    `OLLAMA_SUSPEND_COOLDOWN_MS` (60 s), then exactly one fresh local attempt.
    Fails again → the cooldown re-arms. This replaced a permanent latch that
    made "start Ollama later" require a backend restart.
  - `auth` (unknown model tag, HTTP 404) → stays suspended. A wrong tag cannot
    fix itself, so it is never retried on a timer; a live `/api/tags` probe that
    finds the model installed clears it.
  - `schema` (empty/malformed local output) → **never** suspended: that is a
    model-capability fault, not availability, so each turn may try local again.
  - A successful local response clears the cooldown; `POST /v1/validation` also
    clears it on a positive probe, so the operator never has to restart.
- **Quota honesty**: if *any* provider 429s during the chain, the operation
  surfaces HTTP 429 even when a later provider fails differently — so the
  route answers `RATE_LIMITED` ("wait and retry") instead of lying with
  `REASONING_FAILED` ("AI service unavailable").
- Failover is cross-provider and bounded; `reasoningOrder` contains each
  provider at most once, so it cannot ping-pong.

### 2.4 Validation (`handleValidation`)

Runs four live checks in parallel, same payload shape always
(`{ groq, tts, openrouter, ollama, tavily }` with `{ ok, detail }` each):

- `groq` — live `GET api.groq.com/openai/v1/models` + required model IDs
  (qwen, gpt-oss fallback, whisper, TTS voice). Same key pool as Whisper, so it
  also proves the transcription key.
- `tts` — one tiny live synthesis (proves the voice path; fails honestly with
  `TTS_TERMS` until the Groq-console terms for the speech model are accepted).
- `openrouter` — key-authenticated ping (absent key = healthy "Groq-only",
  not a failure).
- `ollama` — reachability + exact model-tag presence, **no inference**
  (fast, no tokens). Unconfigured = healthy N/A. A **positive** probe also
  clears any local-provider suspension (§2.3), so pressing *Validate backend
  (live)* after starting Ollama restores local reasoning immediately.
- `tavily` — presence only (validation must not spend search credits).

---

## 3. Frontend — the hands and voice (`frontend/src/`)

MV3 extension. No keys, no raw CDP, no `eval`, no shell (all three are banned
by automated security tests — `security/final-audit.test.ts`,
`skills/builtin/builtin.test.ts`, `mcp/mcp.test.ts`).

### 3.1 Agent loop (`background/agent-controller/controller.ts`)

`run()` is a bounded `for(;;)` (belt-and-suspenders guard: 40 iterations):
each pass loads the task, stops on terminal/waiting/paused states, then
`stepOnce()` (model reasoning) or `stepSkill()` (skill in flight drives
itself, one action per step, re-observed each time).

`stepOnce()` order of operations:

1. **Backend required** — absent backend → `FAILED / AI_SERVICE_UNAVAILABLE`.
   (Local-model turns still need the backend: it proxies Ollama.)
2. **Budgets** — `MAX_ACTIONS_PER_TASK` (25), `MAX_QWEN_CALLS_PER_TASK` (30),
   `MAX_TASK_DURATION_MS` → `LIMIT_REACHED`.
3. **Snapshot** — fresh page snapshot (`PageSnapshotLike`: url, title,
   `generation`, element refs `e1…eN`, headings/landmarks/forms, trimmed prose).
   Unsupported schemes (`chrome://`, `edge://`, …) → `UNSUPPORTED_PAGE`.
4. **Deterministic open-site navigation (step 0 only)** —
   - Bare `"open YouTube"` / `"open GitHub"` → frozen allowlist URL
     (`shared/constants.ts: OPEN_SITE_ALLOWLIST`), zero reasoning calls.
   - Compound `"open YouTube and play lofi"` → same deterministic navigate,
     task **stays alive**; the model reasons over the fresh page toward the
     full goal (`resolveOpenSitePrefix`). The model is forbidden from inventing
     URLs, so this first step is never left to it.
5. **Enrichment** — Layer B summary via `/v1/enrich` when missing/stale;
   advisory only, failures suppressed per page generation (a failed enrich used
   to double Qwen calls and cause the rate limits that killed voice turns).
6. **Reason** — `buildUserPayload` with goal + completed-action count +
   `lastVerifiedResult` + available-skill advertisements → `reasonOnce`
   (frontend thin client → backend `/v1/chat`).
7. **Dispatch** (`dispatchOutcome`) — `answer` (speak it), `action`
   (`doAction`: WebGuard → execute → verify), `web_search` (results become the
   task's verified observation; loop continues, never finishes the task),
   `confirmation_required` (pause for user), `task_complete` (finish).

`doAction()`:
- WebGuard policy (`background/webguard/policy.ts`) → `ALLOW | BLOCK |
  REQUIRE_CONFIRMATION` (+ remembered per-task approvals, so it never asks twice).
- Execution via `runRoutedExecution` → local executor or the external
  **harness slot** (§3.6).
- Verification engine (`verification/`) — expectations like
  `element_present`, `navigation_completed`, `submit_completed`; stale
  generations and invented refs are rejected, never executed blind.
- Success → `completedActions+1`, `currentStep+1`, `lastVerifiedResult` set,
  episode recorded (`learning/`), loop continues.

### 3.2 Action space (`shared/types.ts`, `shared/bridge-protocol.ts`)

`click | type | focus | select | scroll | press_key | navigate | go_back |
go_forward | read | web_search | open_tab | close_tab` — plus `expect`
clauses on mutating actions. `web_search` is local-only (backend search, never
a browser op). `javascript:` URLs are rejected by the validator. There is no
`eval`, no CDP, no video-player primitive — media control is generic clicking.

### 3.3 Confirmation & safety

- Model can emit `confirmation_required` (with the pending action attached).
- Task enters `WAITING_FOR_CONFIRMATION` (90 s TTL), speaks the prompt
  (priority 1 speech), resumes only on an explicit yes (`shared/confirmation.ts`
  grammar) — e.g. *buy → cart → stop → "confirm?" → yes → pay*.
- Episodes record every step (`awaiting_confirmation`, `executed`, `blocked`,
  `failed`) for audit and learning; skills go candidate → trusted lifecycle
  with Phase-1 validation.

### 3.4 Skills, learning, MCP

- `skills/` — versioned procedures resolving to existing actions; registry +
  builtin skills (e.g. GitHub flows); capability advertisement puts usable
  skills into the reasoning prompt so the model picks procedures instead of
  re-deriving steps.
- `learning/` — episode store, candidate-skill generation with validators
  (CDP/shell/`eval` proposals are structurally rejected).
- `mcp/mcp-server.ts` — tool surface explicitly *without* raw CDP, JS eval,
  shell, or filesystem.

### 3.5 Voice (the blind-assist loop)

- Capture: offscreen document mic → `VoiceCapture` → `VoiceTurnManager`.
- STT: `ai/whisper-client.ts` POSTs base64 audio to backend `/v1/transcribe`
  (Groq Whisper). One attempt, no client retries on 429 (quota protection).
- Speech: `offscreen/audio-controller.ts` priority queue (1 = safety/
  confirmation … 5 = focus chatter) with preemption, dedupe, half-duplex gate
  (capture pauses while speaking), `VOICE_STATUS` narration events to the tab
  overlay, and an on-device diag log readable in Options.
- **VoiceLens speaks with the browser's own voice ONLY**
  (`offscreen/offscreen.ts`): the Groq voice API is deliberately unwired (stub
  throws before any network), every utterance falls through to local
  `speechSynthesis`. Zero provider quota on speech, works offline from the
  cloud. Backend `/v1/tts` remains for compat + validation display.
- Speech text comes from `shared/messages.ts` — fixed, honest, bilingual
  (en/hi) strings per outcome code, never model prose for errors.

### 3.6 The "browser harness" slot (status: implemented, opt-in — see §8)

`bridge/harness-bridge.ts` defines `BrowserHarnessBridge` + the
`ExternalExecutor` interface the controller consults: an *external* executor
living **outside** the MV3 core, speaking only the versioned typed capability
protocol — one bounded attempt, replies schema-validated, any failure falls
back to local execution. Today **nothing in production instantiates it**
(only tests do). There is no host process, no transport, no CDP driver — and
raw CDP inside the extension is deliberately banned. Filling the slot means
building an external native-host driver + messaging transport; it upgrades
*execution*, not reasoning (current failures are quota/model, where execution
already works).

---

## 4. End-to-end traces

**A. "Open YouTube and play lofi" (voice).**
Capture → transcribe ("open YouTube and play lofi") → task created → step 0:
prefix matches → deterministic navigate `youtube.com` (verified
`navigation_completed`) → step 1: fresh YouTube snapshot + full goal + "action
navigate verified" → Groq plans: type "lofi" into searchbox ref → verify →
click a result → verify → (player controls are generic clicks) → narrate each
`VOICE_STATUS` aloud → `task_complete` → "Done."

**B. "Search the web for X."**
Model emits `web_search` → `searchViaBackend` → `/v1/search` (Tavily) →
results become `lastVerifiedResult` ("web search for X: … | …") → next
reasoning step answers from them or navigates to a result URL. Search never
ends the task by itself.

**C. "Buy that."**
Agent acts (cart etc.) until a consequential step → `confirmation_required` →
task pauses, spoken prompt (priority 1), 90 s TTL → "yes" resumes the exact
pending action; anything else cancels. (Mechanism proven; no store checkout
has been proven end-to-end — bot defenses apply.)

**D. "Validate backend (live)" (Options page).**
`GET /v1/health` (reachability + key counts) → `POST /v1/validation` (four
live checks) → result line (`Groq OK | Speech … | OpenRouter … | Search OK`)
+ URL/token persisted. Failure texts distinguish *unreachable* (backend down),
*401* (token mismatch), and per-provider details.

---

## 5. Budgets, latches, and failure language

| Guard | Value / behavior |
|---|---|
| Actions / task | 25 (`MAX_ACTIONS_PER_TASK`) |
| Reasoning calls / task | 30 (`MAX_QWEN_CALLS_PER_TASK`) |
| Run-loop guard | 40 iterations |
| Contract re-ask | 1 corrective retry per model reply |
| OpenRouter 401/403 | suspended for the process lifetime |
| Ollama down/model-missing | suspended for the process lifetime |
| Any-provider 429 | whole operation reports 429 → frontend speaks `RATE_LIMITED` ("Too many requests. Wait…"), never "AI service unavailable" |
| Ollama transient outage | skipped for `OLLAMA_SUSPEND_COOLDOWN_MS` (60 s), then re-probed once per cooldown — never per-turn, never a retry loop |
| Ollama unknown model tag | suspended until a probe confirms the model, or restart |
| Groq free-tier ceiling | ~8000 tokens/min per account, shared across all keys — the binding constraint on long tasks |
| Sparse image fallback | hybrid-only sparse steps; text tokens + coarse image estimate logged per step; cloud never receives pixels |

---

## 6. Ops

- **Start/restart backend:** `powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1`
  (rebuild → reuse a healthy backend if one is already up, else kill stale →
  wait for the port → start detached → health-check → verify the listening PID is
  the one launched). Logs: `backend/server-8787.out.log` / `.err.log`. The
  backend is launched with its own hidden console, so closing the terminal that
  ran the script no longer kills it. Re-run after any reboot.
- **Startup diagnostics:** on boot the backend logs its listen address/port, the
  configured `LLM_PROVIDER`, the configured Ollama model, and a live Ollama
  reachability probe. If `LLM_PROVIDER=ollama` and Ollama is down it warns that
  turns will fall back to cloud. Startup never fails on an unavailable Ollama.
  Metadata only — no key material.
- **Validate providers:** extension Options → *Validate backend (live)*, or
  `POST 127.0.0.1:8787/v1/validation`.
- **Ollama:** `http://127.0.0.1:11434`; check `ollama list` + `/api/tags`;
  the configured tag must match exactly (`OLLAMA_MODEL`).
- **After editing the extension:** `npm run build --workspace=…` (frontend
  `dist/`) **and reload it in `chrome://extensions`** — the running extension
  is the old build until reloaded.
- **Secrets:** `backend/.env` only (git-ignored, scanner-skipped). `npm run
  scan-secrets` gates releases. Test files use canaries, never real keys.

## 7. Honest limits (read before promising demos)

- Login-walled / bot-guarded sites (LinkedIn, checkouts, CAPTCHAs) beat
  generic DOM operation. No credentials or auth flows exist.
- No shopping checkout proven end-to-end; confirmation gating is proven.
- No YouTube/LinkedIn integrations — one frozen YouTube URL shortcut; all
  else is generic snapshot→act→verify.
- Small local models cannot reliably hold the JSON action contract across
  multi-step tasks (proven in logs with a 3B model). The configured local model
  is `qwen3.5:9b-q4_K_M`; it can still fumble the contract, and when it does
  the turn fails over to cloud (or is re-asked once) rather than acting on a
  malformed outcome. Agency quality therefore still depends on the cloud tier.
- Backend is mandatory for every reasoning step, including "local" turns;
  if the backend process is dead, everything speaks "AI service unavailable."
- External harness slot is filled (see §3.6 / §8) but requires manual
  setup (native host + remote debugging) and live-fire testing; until then
  local execution carries every task.

## 8. Power mode + external harness (operator opt-in)

Two popup toggles (persisted in `config:user`, read fresh on every
controller build):

- **Power mode** — forwards `powerMode: true` into WebGuard: safety gates
  (sensitive-field BLOCK, REQUIRE_CONFIRMATION) are bypassed. Correctness
  BLOCKs (schema, provenance, unknown/stale targets) still apply, and the
  verdict reason records power mode so episodes stay honest. Default off.
- **Harness exec** — sets execution policy `{ allowExternal: true,
  preference: "external" }` and injects `BrowserHarnessBridge` over a
  `chrome.runtime.connectNative` transport (`frontend/src/bridge/`).
  Requires the `nativeMessaging` permission + the host below. Any host
  failure falls back to the local content-script executor; nothing hangs
  (10 s bound per call).

**Host** (`harness/`): Python sidecar `inviz_host.py` (native-messaging
stdio framing) built ON `browser-use/browser-harness` (installed
dependency, MIT — never vendored). Per capability it attaches to the tab
showing the extension's page URL (background attach, no foreground steal;
no match = safe local fallback, never another tab), resolves `{ role, name }`
in the live AX tree, and drives CDP input (compositor-level clicks that
pass through iframes/shadow DOM, framework-aware typing, scroll, keys,
history, region reads). Typed values are never logged. Implemented:
navigate/click/focus/type/scroll/press_key/go_back/go_forward/read_region;
`select` and observations answer "unavailable" → local fallback.
Install: `harness\install.ps1 -ExtensionId <id>` (per-user Chrome registry),
then enable remote debugging once via the daemon's own flow. Test:
`npm run test-harness` (19 stdlib-only tests, no browser needed).

Design lineage: plan-then-commit (deterministic navigation, model for the
rest), snapshot-per-step, explicit `task_complete`, history + budgets,
confirmation-or-power-mode gating, frontier-model floor for agency.

### 3.7 Hybrid vision (opt-in, AX-first, screenshot-alongside)

Experimental channel: in hybrid mode the screenshot rides along on every
step; the DOM snapshot stays the authority and the text-only path is the
degrade fallback — never the other way round.

- **Gating (both ends):** extension `config:user → contextMode` **and**
  backend `CONTEXT_MODE` must both read `hybrid`. Either end at `dom`
  (the default) keeps the exact text-only path — no pixels captured,
  attached, or forwarded.
- **Attach policy:** every hybrid step attaches the viewport screenshot —
  dense or sparse. `assessSnapshotSparsity()` still runs per step (empty /
  ≤8 targets / ≥50% unnamed) but only as a diagnostic: its values
  (`itemCount`, `unnamedCount`, `unnamedFraction`, `sparse`, `reason`)
  are logged on every step so you can see which steps needed vision most.
- **AX-first, never a swap:** every step keeps the **full** AX text
  (`serializePage`, byte-identical to the text path) and **attaches** the
  viewport screenshot next to it. The compact registry is not used on
  this path. `eNN` ids stay the sole executable targets.
- **Capture:** active-tab-only `chrome.tabs.captureVisibleTab`, downscaled
  to 1024px JPEG 0.6 (`HYBRID_IMAGE_MAX_DIMENSION`,
  `HYBRID_IMAGE_JPEG_QUALITY`). Restricted pages, inactive tabs, rate
  limits, and encode failures all degrade to text-only for that step.
- **Local-only:** the backend attaches images to the Ollama request only
  (`localChatBody` + `HYBRID_SYSTEM_SUFFIX_V1`) and drops image +
  vision instruction on any cloud fallback, logging the downgrade.
  Pixels never reach a hosted provider.
- **Budgets:** text tokens via `estimateTokens`; image cost via coarse
  `estimateImageTokens(width, height)` (≈1k tokens/MP — a budget
  comparator, **not** a provider measurement). Attached steps log
  `textTokens` + `estimatedImageTokens` + bytes/dims together.
- **Unchanged:** WebGuard target-existence/generation/provenance,
  executor resolution, and verification expectations. Proven by the
  WebGuard-invariance test (same verdict, same AX text, image or not).
