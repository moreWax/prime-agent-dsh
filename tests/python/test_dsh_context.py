import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

import dsh_context


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


class DshContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.session = Path(self.temp.name) / "session"
        self.root = self.session / "dsh-context"
        (self.root / "objects").mkdir(parents=True)
        self.prime = Path(self.temp.name) / "prime.jsonl"
        self.source = [
            {"type": "message", "id": "u1", "message": {"role": "user", "content": "authentication design"}},
            {"type": "message", "id": "a1", "message": {"role": "assistant", "content": "use scoped grants"}},
        ]
        self.prime.write_bytes(b"".join(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for value in self.source))
        (self.root / "BINDING").write_text(json.dumps({
            "version": "prime-agent-dsh/durable-store-v3-reference", "sessionId": "root-session",
            "primeSessionFile": str(self.prime), "bindingDigest": "0" * 64,
        }))
        self.digest = self._publish("leaf-2", 2)
        os.environ["RLM_SESSION_DIR"] = str(self.session)

    def _publish(self, branch, revision):
        raw_prime = self.prime.read_bytes()
        offset = 0
        locators = []
        source_digests = []
        messages = []
        for index, value in enumerate(self.source):
            line = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            entry_digest = hashlib.sha256(canonical(value)).hexdigest()
            source_digests.append(entry_digest)
            locators.append({"index": index, "byteOffset": offset, "byteLength": len(line), "line": index + 1,
                             "entryDigest": entry_digest, "entryId": value["id"]})
            messages.append(value["message"])
            offset += len(line) + 1
        self.assertEqual(offset, len(raw_prime))
        effective_digests = [hashlib.sha256(canonical(value)).hexdigest() for value in messages]
        source_digest = hashlib.sha256(canonical(self.source)).hexdigest()
        effective_digest = hashlib.sha256(canonical(messages)).hexdigest()
        compatibility = {
            "version": "prime-agent-dsh/durable-store-v3-reference", "sessionId": "root-session",
            "branchId": branch, "revision": revision, "messageCount": len(messages), "entries": [],
            "cropped": False, "sourceDigest": source_digest, "effectiveDigest": effective_digest,
            "converterVersion": "c", "schemaVersion": "prime-agent-dsh/context-object-v1",
            "metrics": {"cacheReadTokens": 12, "cacheWriteTokens": 3},
        }
        stored = {
            "version": "prime-agent-dsh/derived-object-v3-reference", "bindingDigest": "0" * 64,
            "sourceDigest": source_digest, "effectiveDigest": effective_digest,
            "sourceEntryDigests": source_digests, "effectiveEntryDigests": effective_digests,
            "sourceLocators": locators,
            "effectiveReferences": [{"entryDigest": value, "sourceIndex": index, "role": messages[index]["role"]}
                                    for index, value in enumerate(effective_digests)],
            "compatibility": compatibility,
        }
        raw = canonical(stored)
        digest = hashlib.sha256(raw).hexdigest()
        (self.root / "objects" / f"{digest}.json").write_bytes(raw + b"\n")
        manifest = {"version": "prime-agent-dsh/context-object-v1", "sessionId": "root-session",
                    "branchId": branch, "revision": revision, "digest": digest,
                    "snapshot": f"objects/{digest}.json"}
        (self.root / "manifest.json").write_text(json.dumps(manifest) + "\n")
        return digest

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
        self._publish("leaf-new", 3)
        with self.assertRaisesRegex(RuntimeError, "branch mismatch"):
            handle.snapshot(expected_branch_id="leaf-2")
        grant = handle.grant(selection, ttl_seconds=60)
        record = json.loads((self.root / "grants" / f"{grant.token}.json").read_text())
        self.assertEqual(record["sourceSnapshotDigest"], self.digest)
        self.assertEqual(record["sourceBranchId"], "leaf-2")

    def test_snapshot_tampering_is_rejected(self):
        (self.root / "objects" / f"{self.digest}.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
            dsh_context.current().snapshot()

    def test_v3_dereferences_prime_without_persisting_body_text(self):
        self.assertNotIn("authentication design", (self.root / "objects" / f"{self.digest}.json").read_text())
        raw = self.prime.read_bytes()
        self.prime.write_bytes(raw.replace(b"authentication", b"evilxxxxxxxxxx"))
        with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
            dsh_context.current().snapshot()

    def test_old_derived_object_schema_is_rejected(self):
        path = self.root / "objects" / f"{self.digest}.json"
        value = json.loads(path.read_text())
        value["version"] = "prime-agent-dsh/derived-object-v2"
        raw = canonical(value)
        digest = hashlib.sha256(raw).hexdigest()
        (self.root / "objects" / f"{digest}.json").write_bytes(raw + b"\n")
        manifest = json.loads((self.root / "manifest.json").read_text())
        manifest.update(digest=digest, snapshot=f"objects/{digest}.json")
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "unsupported DSH derived object schema"):
            dsh_context.current().snapshot()


if __name__ == "__main__":
    unittest.main()
