# Permission & Minimization Review (PRD 6.8 §1.1)

Audited against actual API usage (`grep chrome.*` over `src/`, 2026-10-05).
Rule applied: every entry must have a live caller; speculative entries are removed.

## Declared permissions (final)

| Permission | Live callers | Justification |
|---|---|---|
| `storage` | popup/options (credentials, config), SW (session flags), stores (TaskState, PageState, Layer B) | Required: the entire state model of PRD 6 §4.6 |
| `tabs` | `tabs.query/update/goBack/goForward/create/remove/sendMessage`, `onUpdated/onRemoved` (SW, executor, wiring) | Required: L1 browser operations + tab lifecycle tracking |
| `commands` | 4 manifest commands + `commands.onCommand` (SW) | Required: keyboard-first activation (PRD 1 §7.1), the only primary activation path |
| `offscreen` | `offscreen.createDocument` (wiring) | Required: mic capture + audio playback runtime (MV3 has no alternative) |

## Removed in this review

| Permission | Reason for removal |
|---|---|
| `scripting` | No `chrome.scripting` call exists anywhere. Content scripts are manifest-declared; nothing is injected programmatically. |
| `activeTab` | No flow uses it. Tab messaging needs no host grant; navigation uses `tabs` API; future sites are covered by explicit match patterns, not ambient grants. |

## Host permissions / content-script matches

- `host_permissions`: `[]` (none requested).
- Content-script `matches`: `http://127.0.0.1:8080/*`, `http://localhost:8080/*` (fixture site only), `all_frames: false`, `run_at: document_idle`.
- Production scoping is deferred to site qualification (PRD 6.7): each qualified site
  adds its explicit match pattern; `<all_urls>` is prohibited without an owner-signed
  justification recorded here. Current status: NOT requested, NOT justified.

## Sensitive-surface posture

- Microphone: runtime grant via the options-page gesture (no manifest permission exists
  for it); denied state has an honest remediation path (Phase 2 exit proof).
- No `debugger`, `webRequest`, `cookies`, `history`, `bookmarks`, `management`,
  or native-messaging surface is declared or used.

Re-run this review on every manifest change (release gate R1).
