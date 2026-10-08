# INVIZ harness host (browser-use/browser-harness execution)

External executor for the INVIZ extension: a Python sidecar that performs
bridge capabilities (click, type, navigate, …) against your real Chrome
through the **browser-use/browser-harness** daemon (CDP), instead of the
extension's built-in content-script executor.

How it fits:

```
voice → extension controller → WebGuard → router
  → harness ON  → native messaging → inviz_host.py → browser_harness daemon → Chrome (CDP)
  → harness OFF / host missing / host fails → local content-script executor (unchanged)
```

The extension keeps reasoning, guarding, consenting, verifying, and
narrating. The host only moves the mouse/keyboard. It holds no keys and
never sees page secrets in logs (typed values are never logged).

## Prereqs

- Python 3.12+ with `browser-harness` installed:
  `python -m pip install browser-harness`
- Chrome (the browser the extension is installed in).
- First run: the daemon needs Chrome remote debugging approved once —
  it opens `chrome://inspect/#remote-debugging` itself; tick the checkbox
  (Windows: click Allow if prompted).

## Install

From the repo root (`INVIZ/`), with your extension ID from
`chrome://extensions` (Developer mode shows it):

```powershell
powershell -ExecutionPolicy Bypass -File harness\install.ps1 -ExtensionId <your-extension-id>
python harness/host_selftest.py
```

This registers the `com.inviz.harness` native host for your user only
(HKCU). No admin rights needed.

## Enable in the extension

1. Reload INVIZ in `chrome://extensions`.
2. Open the INVIZ popup → **Enable Harness exec**.
3. Optionally → **Enable Power mode** (skips confirmation gates;
   correctness BLOCKs and the audit trail stay on).

Without the host installed/running, every action transparently falls back
to local execution — nothing breaks, nothing hangs (10 s bound per call).

## Files

| File | What |
|---|---|
| `inviz_host.py` | The sidecar: stdio framing + capability handlers on `browser_harness` |
| `host_selftest.py` | Stdlib-only self-test (framing, validation, AX matching). No browser needed |
| `install.ps1` | Registers the native host (ASCII-only by PS 5.1 necessity) |
| `inviz-harness.bat` | Generated launcher (python + sidecar). Do not hand-edit |
| `com.inviz.harness.json` | Generated native-host manifest. Do not hand-edit |

## Capability coverage

Implemented: `navigate`, `click`, `focus`, `type`, `scroll`,
`press_key`, `go_back`, `go_forward`, `read_region`.
Everything else answers "unavailable" so the extension runs locally.

Grounding: the extension sends `{ role, name }` + page URL per action; the
host attaches to the tab showing that URL (background attach, no foreground
steal) and resolves the node in the live accessibility tree. No URL match →
safe local fallback, never another tab.

## License note

`browser-harness` is MIT-licensed by Browser Use and is consumed here as an
installed dependency (never vendored). INVIZ itself remains UNLICENSED
(private). If you redistribute this folder, keep their copyright notice
(`pip show browser-harness` → project links).
