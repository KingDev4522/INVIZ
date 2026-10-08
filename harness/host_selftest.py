"""Sidecar self-test (stdlib unittest only). No browser, no daemon, no network.

Run: python harness/host_selftest.py   (from the repo root INVIZ/)
Covers: native-messaging framing, request validation, AX-node matching,
subtree text walk. Live CDP paths are exercised manually, not here.
"""
import io
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import inviz_host as host


def ax_node(node_id, role, name, backend_id, ignored=False, children=()):
    node = {"nodeId": node_id, "ignored": ignored, "childIds": list(children)}
    if role is not None:
        node["role"] = {"value": role}
    if name is not None:
        node["name"] = {"value": name}
    if backend_id is not None:
        node["backendDOMNodeId"] = backend_id
    return node


NODES = [
    ax_node(1, "RootWebArea", "Store", 101, children=(2, 3)),
    ax_node(2, "button", "Buy now", 102),
    ax_node(3, "textField", "Search products", 103),
    ax_node(4, "button", "Buy now", None),  # no backend id: unusable
    ax_node(5, "button", "Buy now gifts", 105),
    ax_node(6, "StaticText", "Free shipping", 106),
]


class FramingTest(unittest.TestCase):
    def test_roundtrip(self):
        message = {"protocolVersion": 1, "requestId": "r1", "ok": True}
        buf = io.BytesIO()
        host.write_frame(buf, message)  # BytesIO has write/flush
        data = buf.getvalue()
        length = struct.unpack("<I", data[:4])[0]
        self.assertEqual(length, len(data) - 4)

        class Stream(io.BytesIO):
            def flush(self):
                pass

        out = io.BytesIO()
        host.write_frame(out, message)
        out.seek(0)
        self.assertEqual(host.read_frame(out), message)

    def test_clean_eof(self):
        self.assertIsNone(host.read_frame(io.BytesIO(b"")))

    def test_oversize_rejected(self):
        buf = io.BytesIO(struct.pack("<I", 70_000))
        with self.assertRaises(ValueError):
            host.read_frame(buf)


class ValidationTest(unittest.TestCase):
    def base(self):
        return {
            "protocolVersion": 1,
            "requestId": "bh_t_1",
            "taskId": "t",
            "capability": "click",
            "args": {"target": "e2", "node": {"role": "button", "name": "Buy"}},
        }

    def test_valid(self):
        request, problem = host.validate_request(self.base())
        self.assertIsNotNone(request)
        self.assertEqual(problem, "")

    def test_bad_version(self):
        raw = self.base()
        raw["protocolVersion"] = 99
        request, _ = host.validate_request(raw)
        self.assertIsNone(request)

    def test_unknown_capability(self):
        raw = self.base()
        raw["capability"] = "eval"
        request, _ = host.validate_request(raw)
        self.assertIsNone(request)

    def test_known_but_unimplemented_capability_passes_validation(self):
        # select reaches handle(), which answers unavailable so the
        # extension falls back to local execution.
        raw = self.base()
        raw["capability"] = "select"
        request, _ = host.validate_request(raw)
        self.assertIsNotNone(request)

    def test_missing_ids(self):
        raw = self.base()
        del raw["requestId"]
        request, _ = host.validate_request(raw)
        self.assertIsNone(request)

    def test_non_object(self):
        request, _ = host.validate_request([1, 2])
        self.assertIsNone(request)


class AxMatchTest(unittest.TestCase):
    def test_exact_role_and_name(self):
        self.assertEqual(host.find_ax_node(NODES, "button", "Buy now"), 102)

    def test_textbox_role_map(self):
        self.assertEqual(host.find_ax_node(NODES, "textbox", "Search products"), 103)

    def test_partial_name(self):
        self.assertEqual(host.find_ax_node(NODES, "button", "Buy"), 102)

    def test_wrong_role_rejected(self):
        self.assertIsNone(host.find_ax_node(NODES, "link", "Buy now"))

    def test_missing_name_rejected(self):
        self.assertIsNone(host.find_ax_node(NODES, "button", "Checkout"))

    def test_node_without_backend_id_skipped(self):
        # node 4 matches by role+name but has no backendDOMNodeId.
        self.assertEqual(host.find_ax_node(NODES, "button", "Buy now gifts"), 105)

    def test_subtree_text(self):
        text = host.subtree_text(NODES, 101)
        self.assertIn("Buy now", text)
        self.assertIn("Search products", text)

    def test_subtree_text_unknown_root(self):
        self.assertEqual(host.subtree_text(NODES, 999), "")


class NormTest(unittest.TestCase):
    def test_url_trailing_slash(self):
        self.assertEqual(host.norm_url("https://x.com/"), "https://x.com")

    def test_match_score_ordering(self):
        exact = host.match_score("buy now", "buy now")
        starts = host.match_score("buy", "buy now")
        contains = host.match_score("uy n", "buy now")
        self.assertTrue(exact > starts > contains > host.match_score("x", "buy now"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
