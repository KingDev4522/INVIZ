# INVIZ Backend

Authenticated AI gateway: the only process that touches provider keys or model
traffic. Zero runtime dependencies (Node builtins only).

## Configure

```powershell
Copy-Item .env.example .env   # from the repo root: backend\.env.example
```

Fill in `backend/.env`:

| Variable | Meaning |
|---|---|
| `GROQ_API_KEYS` | Comma-separated Groq keys — reasoning + transcription (+ speech route) |
| `OPENROUTER_API_KEY` | Optional single key — second reasoning vendor (bounded standby) |
| `OPENROUTER_MODEL` | OpenRouter reasoning model (default `google/gemma-4-26b-a4b-it:free`) |
| `OLLAMA_URL` | Optional local reasoning provider; empty/`disabled` = cloud-only |
| `OLLAMA_MODEL` | Local model tag, must match `ollama list` exactly (default `qwen3.5:9b-q4_K_M`) |
| `OLLAMA_KEEP_ALIVE` | Keeps local weights resident between turns (default: server default) |
| `OLLAMA_TIMEOUT_MS` | Per-inference budget, 10k–900k ms (default 180000) |
| `LLM_PROVIDER` | `auto` \| `ollama` \| `groq` \| `openrouter`; `auto`/`ollama` are both local-first |
| `TAVILY_API_KEY` | Single key — web search for the agent (`/v1/search`, 1 credit/call) |
| `PORT` | Listen port (default 8787, loopback only) |
| `BACKEND_TOKEN` | Optional shared secret; empty = loopback development |

`.env` is git-ignored and scan-skipped. Misconfiguration fails fast at startup
with messages that name variables, never values.

Reasoning (chat + enrichment) is **local-first** with a bounded cloud standby
chain `[ollama → openrouter → groq]` — never rotation, so a healthy local
provider ends the request and normal turns spend no cloud quota. Cloud is
contacted only after local actually fails, with instant failover between the
cloud vendors; transcription always stays on Groq.

A local outage is **bounded, not permanent**: after `OLLAMA_SUSPEND_COOLDOWN_MS`
the local provider is re-probed automatically, so starting Ollama later recovers
without restarting the backend. A positive `POST /v1/validation` probe clears
the suspension immediately. An unknown model tag stays suspended (it cannot fix
itself) until the model is pulled and validated.

Speech runs on Groq (`canopylabs/orpheus-v1-english`) through the shared key
pool. The model requires a one-time terms acceptance in the Groq console;
until that is done `/v1/tts` answers `503 TTS_TERMS`. VoiceLens (the
extension) uses the browser's own feminine voice only and never calls this
route — it exists for Options validation and back-compat.

## Run

```powershell
npm run dev      # build + start  (from repo root: npm run start-backend)
```

## Contract

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | open | Capability presence (counts only, never keys) |
| `POST /v1/chat` | bearer if configured | Reasoning → validated `AgentOutcome` (local-first, bounded cloud standby + failover) |
| `POST /v1/enrich` | bearer if configured | Page semantic enrichment (Layer B, advisory, same provider order) |
| `POST /v1/transcribe` | bearer if configured | Whisper transcription → `{text}` |
| `POST /v1/tts` | bearer if configured | Groq synthesis → WAV `{audioBase64}` |
| `POST /v1/validation` | bearer if configured | Live provider smoke checks, sanitized details |
| `POST /v1/search` | bearer if configured | Tavily web search → truncated `{results}` (1 credit/call) |

Full request/response shapes: `shared/api.ts` (single source of truth).
Error envelope everywhere: `{ error: { code, message } }` — messages never
contain keys, transcripts, or page content.

## Test

```powershell
npm test   # unit (pool, validator, routes, TTS, whisper) + contract checks
```
