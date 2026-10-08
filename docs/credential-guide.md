# Credential Guide (for the key owner, non-technical)

INVIZ holds **no provider keys in the browser**. All keys live in one place —
the backend's `.env` file on the machine running the service. The extension
itself stores only the backend address. Keys are never logged, never committed,
never transmitted except to their own provider.

Everything runs on **one provider (Groq)**: the AI thinking, the speech
recognition, and the spoken voice. So there is only one kind of key to manage.

## 1. Backend keys (one-time setup, ~5 minutes)

1. Copy `backend/.env.example` to `backend/.env` (same folder).
2. **Groq keys** — create free key(s) at GroqCloud (groq.com → API Keys; they
   start with `gsk_`). The project needs `qwen/qwen3.8-27b`,
   `whisper-large-v3-turbo` and `canopylabs/orpheus-v1-english`. Paste one or
   more, comma-separated: `GROQ_API_KEYS=gsk_xxx,gsk_yyy`
   Adding a second key is the single most effective way to reduce "too many
   requests" errors, because all three features share Groq's quota.
3. **Accept the voice model's terms (one time, required for speech).**
   Open the model page in the Groq console and accept:
   `https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english`
   Until this is done, INVIZ still works but speaks with the browser's own
   built-in voice instead of the AI voice.
4. (Recommended) Set a shared secret so only your extension can call the
   backend: `BACKEND_TOKEN=a-long-random-string`. You will paste the same
   string into the extension Options page.
5. Start the backend: `npm run start-backend` (from the repo root).
   It prints its address (default `http://127.0.0.1:8787`) and key counts —
   never key values.

## 2. Extension setup (~1 minute)

1. Load the extension (`frontend/dist/`, see README).
2. Options page → **Backend URL**: `http://127.0.0.1:8787` (+ the token if set).
3. Press **Validate backend**. You should see **Groq OK | Speech OK** (the
   backend runs its own provider smoke checks and reports each result). A
   successful Speech check also plays a spoken "VoiceLens audio check."

## 3. Rotation (under 5 minutes)

Provider dashboard → revoke/re-create → edit `backend/.env` → restart backend →
Options → Validate. No code, extension, or settings changes anywhere else.

## 4. If something fails

| Symptom | Meaning | Fix |
|---|---|---|
| Backend exits at startup naming a variable | That variable is missing/invalid in `.env` | Fill it in (message names the variable, never the value) |
| Extension: "not configured" | No backend URL saved | Complete section 2 above |
| Validate: unreachable | Backend not running / wrong URL | Start backend; check the URL |
| Validate: 401 | Token mismatch | Match Options token to `BACKEND_TOKEN` |
| Groq FAIL in validation | Invalid key or missing model access | Re-create key; enable models on GroqCloud |
| Speech FAIL: "terms not accepted" | Step 3 above was skipped | Accept the terms once in the Groq console |
| Speech FAIL: "rate limited" | Too many requests for the account | Add a second key to `GROQ_API_KEYS`, or wait a minute |
| Speech uses a different, robotic voice | The AI voice is unavailable and the browser's built-in voice took over | See Speech FAIL rows above |