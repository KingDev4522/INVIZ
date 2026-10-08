"""INVIZ harness host: native-messaging sidecar built on browser-use/browser-harness.

Stands OUTSIDE the MV3 extension (Chrome native-messaging host
`com.inviz.harness`). Reads INVIZ bridge requests from stdin using Chrome's
native-messaging framing (u32LE length + JSON), executes each capability
against the user's real Chrome through the browser_harness daemon
(CDP: accessibility tree grounding, compositor-level input), and writes
bridge responses to stdout with the same framing.

Requires: `pip install browser-harness`, Chrome with remote debugging
enabled (the daemon walks you through it on first run).

Safety notes (read before enabling Power mode in the extension):
- This host performs REAL clicks/typing/navigation in YOUR browser.
- It never sees provider keys; requests carry no secrets. Typed VALUES
  (which may be passwords in power mode) are NEVER logged.
- Unknown/unsupported capabilities answer ok:false so the extension falls
  back to its local executor. One attempt per request, no retries.
"""
import json
import struct
import sys
import time

PROTOCOL_VERSION = 1

CAPABILITIES = (
    "click",
    "type",
    "focus",
    "scroll",
    "press_key",
    "navigate",
    "go_back",
    "go_forward",
    "read_region",
)

# Extension snapshot role -> CDP AX role values.
ROLE_MAP = {
    "button": ("button",),
    "link": ("link",),
    "textbox": ("textField", "searchBox", "textbox"),
    "searchbox": ("searchBox", "textField"),
    "checkbox": ("checkBox",),
    "combobox": ("comboBox",),
    "switch": ("switch",),
    "radio": ("radioButton",),
}

INTERNAL_PREFIXES = ("chrome://", "chrome-untrusted://", "devtools://",
                     "chrome-extension://", "about:")


def norm_url(url):
    return (url or "").rstrip("/")


def norm_text(text):
    return " ".join((text or "").lower().split())


def match_score(want, have):
    if not want or not have:
        return 0
    if want == have:
        return 3
    if have.startswith(want) or want.startswith(have):
        return 2
    if want in have or have in want:
        return 1
    return 0


def find_ax_node(nodes, role, name):
    """Best AX node for (role, name). Returns backendDOMNodeId or None."""
    want = (role or "").lower()
    want_roles = {r.lower() for r in ROLE_MAP.get(want, (want,))}
    want_name = norm_text(name)
    best = None
    best_score = (0, 0)
    for node in nodes:
        if node.get("ignored"):
            continue
        backend_id = node.get("backendDOMNodeId")
        if not backend_id:
            continue
        ax_role = str(((node.get("role") or {}).get("value")) or "").lower()
        if want_roles and ax_role not in want_roles:
            continue
        have_name = norm_text(str(((node.get("name") or {}).get("value")) or ""))
        score = match_score(want_name, have_name)
        if score == 0:
            continue
        # Same match class: prefer the name closest in length to the request
        # (a short query must not lose to a longer label that merely contains
        # it; exact matches have distance 0 and always win ties).
        rank = (score, -abs(len(have_name) - len(want_name)))
        if best is None or rank > best_score:
            best = backend_id
            best_score = rank
    return best


def subtree_text(nodes, root_backend_id, limit=4000):
    # childIds are AX nodeIds (not backend ids): index by nodeId, locate the
    # node carrying our backend id, then walk its children.
    by_node_id = {}
    for node in nodes:
        nid = node.get("nodeId")
        if nid is not None:
            by_node_id[nid] = node
    start = None
    for node in nodes:
        if node.get("backendDOMNodeId") == root_backend_id:
            start = node
            break
    if start is None:
        return ""
    parts = []
    stack = [start]
    while stack and sum(len(p) for p in parts) < limit:
        node = stack.pop()
        name = ((node.get("name") or {}).get("value")) or ""
        value = ((node.get("value") or {}).get("value")) or ""
        text = (name + " " + str(value)).strip()
        if text:
            parts.append(text)
        for child_id in reversed(node.get("childIds") or []):
            child = by_node_id.get(child_id)
            if child is not None and not child.get("ignored"):
                stack.append(child)
    return " | ".join(parts)[:limit]


class Harness:
    def __init__(self):
        from browser_harness.admin import ensure_daemon
        ensure_daemon()
        from browser_harness import helpers as bh
        self.bh = bh

    def attach_to_url(self, url):
        """Attach the daemon to the tab showing url (background attach, no
        foreground steal). Returns True, or False when no matching tab exists
        (caller must then fail safe so the extension runs locally)."""
        want = norm_url(url)
        try:
            tabs = self.bh.list_tabs(include_chrome=False)
        except Exception:
            return False
        for tab in tabs:
            if norm_url(tab.get("url")) == want:
                try:
                    self.bh.switch_tab(tab.get("targetId") or tab.get("target_id"))
                    return True
                except Exception:
                    return False
        return False

    def node_center(self, backend_id):
        """Viewport click point for an AX node (their SKILL.md recipe:
        getBoxModel content-center is viewport px, ready for click_at_xy)."""
        try:
            self.bh.cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=backend_id)
        except Exception:
            pass
        box = self.bh.cdp("DOM.getBoxModel", backendNodeId=backend_id)["model"]["content"]
        x = sum(box[0::2]) / 4.0
        y = sum(box[1::2]) / 4.0
        return x, y

    def resolve(self, node):
        nodes = self.bh.cdp("Accessibility.getFullAXTree")["nodes"]
        role = (node or {}).get("role", "")
        name = (node or {}).get("name", "")
        backend_id = find_ax_node(nodes, role, name)
        if backend_id is None:
            raise RuntimeError("element not found in accessibility tree: role=%r name=%r"
                               % (role, name[:80]))
        return backend_id

    def do_navigate(self, args):
        params = args.get("parameters") or {}
        url = params.get("url", "")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return err("invalid_args", "navigate needs parameters.url http(s)")
        self.bh.goto_url(url)
        self.bh.wait_for_load(timeout=10.0)
        try:
            current = self.bh.current_tab().get("url", "")
        except Exception:
            current = ""
        return ok({"kind": "result", "url": current})

    def do_click(self, args):
        backend_id = self.resolve(args.get("node"))
        x, y = self.node_center(backend_id)
        self.bh.click_at_xy(x, y)
        return ok({"kind": "result"})

    def do_focus(self, args):
        backend_id = self.resolve(args.get("node"))
        x, y = self.node_center(backend_id)
        self.bh.click_at_xy(x, y)
        return ok({"kind": "result"})

    def do_type(self, args):
        value = args.get("value", "")
        if not isinstance(value, str):
            return err("invalid_args", "type needs string value")
        backend_id = self.resolve(args.get("node"))
        x, y = self.node_center(backend_id)
        self.bh.click_at_xy(x, y)
        # Select-all + clear via raw key events (their fill_input recipe),
        # then insert. No per-character typing.
        self.bh.cdp("Input.dispatchKeyEvent", type="rawKeyDown", key="a",
                    code="KeyA", modifiers=2, windowsVirtualKeyCode=65,
                    nativeVirtualKeyCode=65)
        self.bh.cdp("Input.dispatchKeyEvent", type="keyUp", key="a",
                    code="KeyA", modifiers=2, windowsVirtualKeyCode=65,
                    nativeVirtualKeyCode=65)
        self.bh.press_key("Backspace")
        self.bh.type_text(value)
        return ok({"kind": "result"})

    def do_scroll(self, args):
        node = args.get("node")
        if isinstance(node, dict):
            try:
                x, y = self.node_center(self.resolve(node))
            except Exception:
                info = self.bh.page_info()
                x, y = info.get("w", 800) / 2.0, info.get("h", 600) / 2.0
        else:
            info = self.bh.page_info()
            x, y = info.get("w", 800) / 2.0, info.get("h", 600) / 2.0
        params = args.get("parameters") or {}
        direction = params.get("direction", args.get("value", "down"))
        dy = -500 if str(direction).lower() in ("up", "top") else 500
        self.bh.scroll(x, y, dy=dy)
        return ok({"kind": "result"})

    def do_press_key(self, args):
        params = args.get("parameters") or {}
        key = params.get("key", "")
        if not isinstance(key, str) or not key:
            return err("invalid_args", "press_key needs parameters.key")
        self.bh.press_key(key)
        return ok({"kind": "result"})

    def do_history(self, delta):
        nav = self.bh.cdp("Page.getNavigationHistory")
        entries = nav.get("entries", [])
        index = nav.get("currentIndex", 0)
        target = index + delta
        if target < 0 or target >= len(entries):
            return err("internal", "no history entry in that direction")
        self.bh.cdp("Page.navigateToHistoryEntry", entryId=entries[target]["id"])
        self.bh.wait_for_load(timeout=10.0)
        return ok({"kind": "result"})

    def do_read_region(self, args):
        node = args.get("node")
        nodes = self.bh.cdp("Accessibility.getFullAXTree")["nodes"]
        if isinstance(node, dict):
            backend_id = find_ax_node(
                nodes, node.get("role", ""), node.get("name", ""))
            if backend_id is None:
                return err("internal", "region element not found")
            text = subtree_text(nodes, backend_id)
        else:
            text = subtree_text_all(nodes)
        return ok({"kind": "region", "text": text[:4000]})

    def handle(self, request):
        request_id = request.get("requestId", "")
        capability = request.get("capability", "")
        args = request.get("args") or {}
        if capability not in CAPABILITIES:
            # Deliberately "unavailable": the extension falls back to its
            # local executor instead of treating this as a task failure.
            return {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": False,
                "errorCode": "unavailable",
                "detail": "capability not implemented by host: %s" % capability,
            }
        url = request.get("url", "")
        if capability != "navigate":
            # Act on the SAME tab the extension sees. No match (or unknown
            # url) => fail safe to local execution, never another tab.
            if not isinstance(url, str) or not url or not self.attach_to_url(url):
                return {
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "errorCode": "unavailable",
                    "detail": "no matching tab for url",
                }
        try:
            if capability == "navigate":
                # Navigation targets the attached tab; the daemon preserves it
                # across calls, and goto keeps working there afterwards.
                resp = self.do_navigate(args)
            elif capability == "click":
                resp = self.do_click(args)
            elif capability == "focus":
                resp = self.do_focus(args)
            elif capability == "type":
                resp = self.do_type(args)
            elif capability == "scroll":
                resp = self.do_scroll(args)
            elif capability == "press_key":
                resp = self.do_press_key(args)
            elif capability == "go_back":
                resp = self.do_history(-1)
            elif capability == "go_forward":
                resp = self.do_history(1)
            elif capability == "read_region":
                resp = self.do_read_region(args)
            else:
                resp = err("unavailable", "not implemented")
        except Exception as exc:
            resp = err("internal", str(exc)[:300])
        resp["protocolVersion"] = PROTOCOL_VERSION
        resp["requestId"] = request_id
        return resp


def ok(observation):
    return {"ok": True, "observation": observation}


def err(code, detail):
    return {"ok": False, "errorCode": code, "detail": detail[:300]}


def subtree_text_all(nodes, limit=4000):
    parts = []
    for node in nodes:
        if node.get("ignored"):
            continue
        name = ((node.get("name") or {}).get("value")) or ""
        if name.strip():
            parts.append(name.strip())
        if sum(len(p) for p in parts) >= limit:
            break
    return " | ".join(parts)[:limit]


def read_frame(stream):
    header = stream.read(4)
    if len(header) == 0:
        return None  # clean EOF
    if len(header) < 4:
        raise EOFError("truncated frame header")
    (length,) = struct.unpack("<I", header)
    if length > 64 * 1024:
        raise ValueError("frame exceeds 64 KiB bound")
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            raise EOFError("truncated frame body")
        body += chunk
    return json.loads(body.decode("utf-8"))


def write_frame(stream, message):
    body = json.dumps(message).encode("utf-8")
    stream.write(struct.pack("<I", len(body)))
    stream.write(body)
    stream.flush()


def validate_request(raw):
    if not isinstance(raw, dict):
        return None, "request must be an object"
    if raw.get("protocolVersion") != PROTOCOL_VERSION:
        return None, "unsupported protocol version"
    for field in ("requestId", "taskId", "capability"):
        if not isinstance(raw.get(field), str) or not raw[field]:
            return None, "missing %s" % field
    if raw["capability"] not in CAPABILITIES and raw["capability"] not in (
            "get_page_state", "find_element", "read_region", "wait_for",
            "observe", "select", "web_search", "open_tab", "close_tab"):
        return None, "unknown capability"
    args = raw.get("args")
    if args is not None and not isinstance(args, dict):
        return None, "args must be an object"
    return raw, ""


def log(*parts):
    # stdout is FRAMES ONLY. Diagnostics go to stderr, metadata only —
    # typed values may be secrets in power mode and are never logged.
    sys.stderr.write("inviz_host: " + " ".join(str(p) for p in parts) + "\n")
    sys.stderr.flush()


def main():
    harness = Harness()
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    log("ready")
    while True:
        try:
            raw = read_frame(stdin)
        except Exception as exc:
            log("framing error:", exc)
            break
        if raw is None:
            break
        request, problem = validate_request(raw)
        if request is None:
            # Answer (when a requestId is salvageable) instead of dropping:
            # a dropped request would hang the extension until its timeout.
            log("rejected request:", problem)
            fallback_id = raw.get("requestId") if isinstance(raw, dict) else ""
            if isinstance(fallback_id, str) and fallback_id:
                try:
                    write_frame(stdout, {
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": fallback_id,
                        "ok": False,
                        "errorCode": "invalid_args",
                        "detail": problem[:300],
                    })
                except Exception as exc:
                    log("write error:", exc)
                    break
            continue  # fail closed per-request; keep serving
        started = time.monotonic()
        try:
            response = harness.handle(request)
        except Exception as exc:  # never kill the loop on one request
            response = {
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": raw.get("requestId", ""),
                "ok": False,
                "errorCode": "internal",
                "detail": str(exc)[:300],
            }
        elapsed = time.monotonic() - started
        log("capability=%s ok=%s elapsed=%.1fs" % (
            request.get("capability"), response.get("ok"), elapsed))
        try:
            write_frame(stdout, response)
        except Exception as exc:
            log("write error:", exc)
            break


if __name__ == "__main__":
    main()
