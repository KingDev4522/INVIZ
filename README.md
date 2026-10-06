# INVIZ

AI-powered accessibility browser assistant: a Chrome extension (Manifest V3,
TypeScript) backed by a local AI gateway service (Node, zero runtime deps).

Strict split: `frontend/` holds every browser-controlled file and **zero
provider keys** (enforced by test). `backend/` holds every provider key and all
model traffic. `shared/` holds the contracts both sides import. They meet only
at the typed REST boundary (`shared/api.ts`).

Authoritative build contract: `docs/PRD 6 - Implementation Plan and Build Phases.txt`,
per-phase specs `docs/PRD 6.0`–`docs/PRD 6.8`.

## Prerequisites

- Node.js 20+ (verified with Node 24), Google Chrome 116+.

## Run the backend

```powershell
npm install
Copy-Item backend\.env.example backend\.env   # then fill in the two keys
npm run start-backend                          # http://127.0.0.1:8787
```

Backend details: `backend/README.md`. Keys live in `backend/.env` only
(git-ignored, scan-skipped by design). Optional `BACKEND_TOKEN` gates every
route except `/v1/health`.

## Build + load the extension

```powershell
npm run build --workspace=frontend
```

Output is `frontend/dist/` — the load-unpacked artifact (rebuilt reproducibly).

1. Open `chrome://extensions`, enable Developer mode.
2. "Load unpacked" → select the `frontend/dist/` folder.
3. Open the extension Options page → enter the **backend URL**
   (`http://127.0.0.1:8787`) and token if configured → **Validate backend**.

## Credentials (late-bound, never committed, never in frontend)

- `GROQ_API_KEYS` (1..N, backend `.env`) powers reasoning
  (`qwen/qwen3.8-27b`) and transcription (`whisper-large-v3-turbo`).
  More keys means better distribution of rate limits, since both share
  Groq's quota.
- `OPENROUTER_API_KEY` (single, backend `.env`, optional) is the second
  reasoning vendor: chat + enrichment round-robin OpenRouter
  (`google/gemma-4-26b-a4b-it:free`) ↔ Groq (Qwen) with instant failover.
  Empty = Groq-only reasoning. Audio never leaves Groq.
- `TAVILY_API_KEY` (single, backend `.env`) powers web search, fully
  automatic: every turn goes to the AI, which searches the web itself
  (`web_search` action) when the page can't answer — then answers from the
  results or navigates to one. No buttons, no commands. 1 credit per search;
  queries capped, results truncated.
- VoiceLens speaks with the browser's own feminine voice only
  (`speechSynthesis`, feminine preferred per language, Hindi served by the
  local Hindi voice). The Groq voice API is unwired from VoiceLens, so zero
  provider quota is ever spent on speech. The backend `/v1/tts` route still
  exists (Options validation + back-compat): its model
  (`canopylabs/orpheus-v1-english`) is gated behind a one-time terms
  acceptance in the Groq console, otherwise it answers `503 TTS_TERMS`.
- The extension stores only the backend URL (+ optional token) in
  `chrome.storage.local`. Missing backend → the extension announces setup
  status and runs deterministic-only mode; it never crashes and never fakes output.

## Develop

```powershell
npm run typecheck --workspaces   # tsc --noEmit, must be clean
npm test --workspaces            # vitest suites, must be green
npm run test-page                # serves test-page/ fixture site at http://127.0.0.1:8080
npm run scan-secrets             # fails on key material outside backend/.env
```

## No-simulation rule (PRD 4 §67)

No component may return scripted/fixture data in place of a live model response.
Static test fixtures (DOM pages, audio clips, recorded-real-response regression
corpora, unreachable from runtime imports) are test data, not runtime behavior.
