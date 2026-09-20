import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

import dsh_context


class DshContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.session = Path(self.temp.name) / "session"
        root = self.session / "dsh-context"
        snapshots = root / "snapshots"
        snapshots.mkdir(parents=True)
        snapshot = {
            "version": "prime-agent-dsh/context-object-v1",
            "sessionId": "root-session",
            "branchId": "leaf-2",
            "revision": 2,
            "messageCount": 2,
            "entries": [
                {"index": 0, "entryType": "message", "role": "user", "text": "authentication design", "truncated": False},
                {"index": 1, "entryType": "message", "role": "assistant", "text": "use scoped grants", "truncated": False},
            ],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "authentication design"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "use scoped grants"}]},
            ],
            "metrics": {"cacheReadTokens": 12, "cacheWriteTokens": 3},
            "cropped": False,
        }
        raw = (json.dumps(snapshot, separators=(",", ":")) + "\n").encode()
        digest = hashlib.sha256(raw).hexdigest()
        (snapshots / f"{digest}.json").write_bytes(raw)
        manifest = {
            "version": snapshot["version"],
            "sessionId": snapshot["sessionId"],
            "branchId": snapshot["branchId"],
            "revision": 2,
            "digest": digest,
            "snapshot": f"snapshots/{digest}.json",
        }
        (root / "manifest.json").write_text(json.dumps(manifest) + "\n")
        self.root = root
        self.digest = digest
        os.environ["RLM_SESSION_DIR"] = str(self.session)

    def tearDown(self):
        os.environ.pop("RLM_SESSION_DIR", None)
        self.temp.cleanup()

    def test_bounded_read_search_metrics_and_admission(self):
        ctx = dsh_context.current()
        self.assertEqual(ctx.snapshot().digest, self.digest)
        self.assertEqual(ctx.entries(last=1)[0].text, "use scoped grants")
        self.assertEqual(ctx.messages(role="user")[0].text, "authentication design")
        self.assertEqual(ctx.search("AUTHENTICATION")[0].index, 0)
        self.assertEqual(ctx.metrics["cacheReadTokens"], 12)
        admitted = ctx.inject(ctx.search("scoped"), label="Evidence")
        self.assertIn('<dsh-context label="Evidence">', admitted)
        self.assertIn("use scoped grants", admitted)

    def test_artifacts_are_content_addressed_and_private(self):
        artifact = dsh_context.current().artifact({"decision": "scoped"}, label="Design")
        self.assertTrue(artifact.path.is_file())
        self.assertEqual(stat.S_IMODE(artifact.path.stat().st_mode), 0o600)
        self.assertEqual(artifact.digest, hashlib.sha256(artifact.path.read_bytes()).hexdigest())

    def test_child_opens_explicit_parent_grant(self):
        grant = dsh_context.current().grant({"evidence": "bounded"}, ttl_seconds=60)
        child = self.session / "sub-child"
        child.mkdir()
        os.environ["RLM_SESSION_DIR"] = str(child)
        opened = dsh_context.open_grant(grant.uri)
        self.assertEqual(opened.value, {"evidence": "bounded"})
        self.assertEqual(opened.source_snapshot_digest, self.digest)

    def test_selection_grant_keeps_original_snapshot_and_expected_branch_is_checked(self):
        handle = dsh_context.current()
        selection = handle.entries(last=1)
        original = handle.snapshot()
        newer = {**original.data, "branchId": "leaf-new", "revision": 3}
        raw = (json.dumps(newer, separators=(",", ":")) + "\n").encode()
        newer_digest = hashlib.sha256(raw).hexdigest()
        (self.root / "snapshots" / f"{newer_digest}.json").write_bytes(raw)
        manifest = {**original.manifest, "branchId": "leaf-new", "revision": 3, "digest": newer_digest, "snapshot": f"snapshots/{newer_digest}.json"}
        (self.root / "manifest.json").write_text(json.dumps(manifest) + "\n")
        with self.assertRaisesRegex(RuntimeError, "branch mismatch"):
            handle.snapshot(expected_branch_id="leaf-2")
        grant = handle.grant(selection, ttl_seconds=60)
        record = json.loads((self.root / "grants" / f"{grant.token}.json").read_text())
        self.assertEqual(record["sourceSnapshotDigest"], self.digest)
        self.assertEqual(record["sourceBranchId"], "leaf-2")

    def test_v2_reconstructs_messages_and_rejects_tampered_bodies(self):
        bodies = self.root / "bodies"
        objects = self.root / "objects"
        bodies.mkdir()
        objects.mkdir()
        source = [{"type": "message", "text": "source exact"}]
        messages = [{"role": "user", "content": [{"type": "text", "text": "v2 exact"}]}]

        def store_bodies(values):
            digests = []
            raws = []
            for value in values:
                raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
                digest = hashlib.sha256(raw).hexdigest()
                (bodies / f"{digest}.json").write_bytes(raw + b"\n")
                digests.append(digest)
                raws.append(raw)
            return digests, hashlib.sha256(b"[" + b",".join(raws) + b"]").hexdigest()

        source_digests, source_digest = store_bodies(source)
        effective_digests, effective_digest = store_bodies(messages)
        compatibility = {
            "version": "prime-agent-dsh/durable-store-v1", "sessionId": "root-session",
            "branchId": "leaf-v2", "revision": 3, "messageCount": 1,
            "entries": [], "cropped": False, "sourceDigest": source_digest,
            "effectiveDigest": effective_digest, "converterVersion": "c", "schemaVersion": "prime-agent-dsh/context-object-v1",
        }
        stored = {
            "version": "prime-agent-dsh/derived-object-v2", "bindingDigest": "0" * 64,
            "sourceDigest": source_digest, "effectiveDigest": effective_digest,
            "sourceEntryDigests": source_digests, "effectiveEntryDigests": effective_digests,
            "compatibility": compatibility,
        }
        raw = json.dumps(stored, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        digest = hashlib.sha256(raw).hexdigest()
        (objects / f"{digest}.json").write_bytes(raw + b"\n")
        manifest = {"version": "prime-agent-dsh/context-object-v1", "digest": digest, "snapshot": f"objects/{digest}.json"}
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        self.assertEqual(dsh_context.current().messages()[0].text, "v2 exact")
        (bodies / f"{effective_digests[0]}.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "body digest mismatch"):
            dsh_context.current().snapshot()

    def test_snapshot_tampering_is_rejected(self):
        path = self.root / "snapshots" / f"{self.digest}.json"
        path.write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
            dsh_context.current().snapshot()


if __name__ == "__main__":
    unittest.main()
