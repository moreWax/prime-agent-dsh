"""Lazy DeepSeek Harness context objects for Prime Agent kernels."""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import secrets
import time
from typing import Any

_VERSION = "prime-agent-dsh/context-object-v1"
_GRANT_VERSION = "prime-agent-dsh/context-grant-v1"
_DEFAULT_LIMIT = 20
_MAX_LIMIT = 200
_MAX_INJECT_BYTES = 65_536
_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
_MAX_GRANT_BYTES = 1024 * 1024
_MAX_GRANT_TTL_SECONDS = 7 * 24 * 60 * 60
_GRANT_TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,128}$")


def _session_dir() -> Path:
    raw = os.environ.get("RLM_SESSION_DIR")
    if not raw:
        raise RuntimeError("RLM_SESSION_DIR is unavailable; dsh_context requires a Prime Agent session kernel")
    return Path(raw).expanduser().resolve()


def _private_root() -> Path:
    root = _session_dir() / "dsh-context"
    manifest = root / "manifest.json"
    if not manifest.is_file():
        raise RuntimeError(
            f"DSH context snapshot is not ready at {manifest}; run one model turn after loading the extension"
        )
    return root


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid DSH context object at {path}")
    return value


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _bounded_limit(limit: int) -> int:
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise TypeError("limit must be a non-negative integer")
    return min(limit, _MAX_LIMIT)


def _message_text(message: dict[str, Any]) -> str:
    out: list[str] = []
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind in ("text", "reasoning") and isinstance(block.get("text"), str):
            out.append(block["text"])
        elif kind == "tool-call":
            out.append(f"[tool {block.get('name', 'unknown')}] {block.get('arguments', '')}")
        elif kind == "tool-result":
            out.append(_message_text({"content": block.get("content", [])}))
        elif kind == "image":
            out.append("[image attachment]")
    return "\n".join(part for part in out if part)


def _jsonable(value: Any) -> Any:
    if isinstance(value, ContextSelection):
        return [item.data for item in value]
    if isinstance(value, ContextItem):
        return value.data
    if isinstance(value, ContextSnapshot):
        return value.data
    if isinstance(value, GrantedContext):
        return value.value
    return value


def _render(value: Any) -> str:
    plain = _jsonable(value)
    if isinstance(plain, str):
        return plain
    return json.dumps(plain, ensure_ascii=False, indent=2, sort_keys=True)


def _crop_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    marker = f"\n[… {len(encoded) - max_bytes} UTF-8 bytes omitted …]"
    budget = max(0, max_bytes - len(marker.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + marker


def _private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"unsafe DSH context directory: {path}")
    os.chmod(path, 0o700)


def _exclusive_write(path: Path, raw: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


@dataclass(frozen=True)
class ContextItem:
    """One immutable entry or model message selected from a snapshot."""

    kind: str
    index: int
    data: dict[str, Any]
    text: str

    @property
    def role(self) -> str | None:
        value = self.data.get("role")
        return value if isinstance(value, str) else None


class ContextSelection(Sequence[ContextItem]):
    """A bounded immutable collection tied to one snapshot digest."""

    def __init__(self, digest: str, items: Iterable[ContextItem]):
        self.digest = digest
        self._items = tuple(items)

    def __getitem__(self, index: int | slice) -> ContextItem | tuple[ContextItem, ...]:
        return self._items[index]

    def __len__(self) -> int:
        return len(self._items)

    def __iter__(self) -> Iterator[ContextItem]:
        return iter(self._items)

    def __repr__(self) -> str:
        return f"ContextSelection(digest={self.digest[:12]!r}, items={len(self)})"


class ContextSnapshot:
    """An immutable content-addressed view of one exact observed Prime branch."""

    def __init__(self, root: Path, manifest: dict[str, Any], data: dict[str, Any]):
        self.root = root
        self.manifest = manifest
        self.data = data
        self.digest = str(manifest["digest"])
        self.session_id = str(data["sessionId"])
        self.branch_id = str(data["branchId"])
        self.revision = int(data["revision"])
        self.cropped = bool(data.get("cropped", False))
        self.unavailable_message_count = int(data.get("unavailableEffectiveEntries", 0))
        metrics = data.get("metrics")
        self.metrics = dict(metrics) if isinstance(metrics, dict) else {}

    def _select(
        self,
        kind: str,
        values: list[Any],
        *,
        start: int,
        limit: int,
        last: int | None,
        role: str | None,
    ) -> ContextSelection:
        if not isinstance(start, int) or isinstance(start, bool) or start < 0:
            raise TypeError("start must be a non-negative integer")
        limit = _bounded_limit(limit)
        items: list[ContextItem] = []
        for index, raw in enumerate(values):
            if not isinstance(raw, dict):
                continue
            item_role = raw.get("role")
            if role is not None and item_role != role:
                continue
            text = str(raw.get("text", "")) if kind == "entry" else _message_text(raw)
            items.append(ContextItem(kind=kind, index=index, data=raw, text=text))
        if last is not None:
            if not isinstance(last, int) or isinstance(last, bool) or last < 0:
                raise TypeError("last must be a non-negative integer or None")
            count = min(last, _MAX_LIMIT)
            return ContextSelection(self.digest, items[-count:] if count else [])
        return ContextSelection(self.digest, items[start : start + limit])

    def entries(
        self,
        start: int = 0,
        limit: int = _DEFAULT_LIMIT,
        *,
        last: int | None = None,
        role: str | None = None,
    ) -> ContextSelection:
        values = self.data.get("entries", [])
        return self._select("entry", values if isinstance(values, list) else [], start=start, limit=limit, last=last, role=role)

    def messages(
        self,
        start: int = 0,
        limit: int = _DEFAULT_LIMIT,
        *,
        last: int | None = None,
        role: str | None = None,
    ) -> ContextSelection:
        values = self.data.get("messages", [])
        return self._select("message", values if isinstance(values, list) else [], start=start, limit=limit, last=last, role=role)

    def search(
        self,
        query: str,
        limit: int = _DEFAULT_LIMIT,
        *,
        regex: bool = False,
        case_sensitive: bool = False,
    ) -> ContextSelection:
        if not isinstance(query, str) or not query:
            raise ValueError("query must be a non-empty string")
        limit = _bounded_limit(limit)
        flags = 0 if case_sensitive else re.IGNORECASE
        pattern = re.compile(query if regex else re.escape(query), flags)
        values = self.data.get("entries", [])
        items: list[ContextItem] = []
        for index, raw in enumerate(values if isinstance(values, list) else []):
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text", ""))
            if pattern.search(text):
                items.append(ContextItem(kind="entry", index=index, data=raw, text=text))
                if len(items) == limit:
                    break
        return ContextSelection(self.digest, items)

    def __repr__(self) -> str:
        return (
            f"ContextSnapshot(session_id={self.session_id!r}, branch_id={self.branch_id!r}, "
            f"revision={self.revision}, digest={self.digest[:12]!r}, cropped={self.cropped})"
        )


@dataclass(frozen=True)
class ContextArtifact:
    path: Path
    digest: str
    bytes: int


@dataclass(frozen=True)
class ContextGrant:
    """Capability token for a bounded immutable parent-context selection."""

    token: str
    digest: str
    expires_at: int
    label: str

    @property
    def uri(self) -> str:
        return f"dsh-context-grant:{self.token}"

    @property
    def instruction(self) -> str:
        return (
            f"A read-only parent context grant is available as {self.uri}. "
            "In the Python REPL call dsh_context.open_grant(" + repr(self.uri) + ") to inspect it."
        )


@dataclass(frozen=True)
class GrantedContext:
    token: str
    label: str
    source_session_id: str
    source_branch_id: str
    source_snapshot_digest: str
    created_at: int
    expires_at: int
    value: Any


class ContextHandle:
    """Live pointer whose operations pin the current immutable snapshot first."""

    def __init__(self, root: Path):
        self.root = root

    def snapshot(self, digest: str | None = None, *, expected_branch_id: str | None = None) -> ContextSnapshot:
        manifest = _read_json(self.root / "manifest.json")
        if manifest.get("version") != _VERSION:
            raise RuntimeError(f"unsupported DSH context manifest version: {manifest.get('version')!r}")
        if digest is None or digest == manifest.get("digest"):
            relative = manifest.get("snapshot")
            if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise RuntimeError("invalid DSH context snapshot path")
            path = (self.root / relative).resolve()
            expected = manifest.get("digest")
        else:
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("snapshot digest must be 64 lowercase hexadecimal characters")
            durable = self.root / "objects" / f"{digest}.json"
            legacy = self.root / "snapshots" / f"{digest}.json"
            path = (durable if durable.is_file() else legacy).resolve()
            expected = digest
            manifest = {**manifest, "digest": digest, "snapshot": str(path.relative_to(self.root))}
        if self.root not in path.parents:
            raise RuntimeError("DSH context snapshot escapes its private root")
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"invalid DSH context snapshot file: {path}")
        raw = path.read_bytes()
        stored = json.loads(raw)
        durable_version = stored.get("version") if isinstance(stored, dict) else None
        is_durable = durable_version in (
            "prime-agent-dsh/derived-object-v1",
            "prime-agent-dsh/derived-object-v2",
            "prime-agent-dsh/derived-object-v3-reference",
        )
        actual = sha256(raw.rstrip(b"\n") if is_durable else raw).hexdigest()
        if actual != expected:
            raise RuntimeError("DSH context snapshot digest mismatch")
        if is_durable:
            compatibility = stored.get("compatibility")
            if not isinstance(compatibility, dict) or compatibility.get("version") != "prime-agent-dsh/durable-store-v1":
                raise RuntimeError("invalid DSH durable context object")
            if durable_version == "prime-agent-dsh/derived-object-v3-reference":
                binding = _read_json(self.root / "BINDING")
                prime_raw = binding.get("primeSessionFile")
                if not isinstance(prime_raw, str) or not os.path.isabs(prime_raw):
                    raise RuntimeError("invalid DSH Prime binding")
                prime_path = Path(prime_raw)
                if prime_path.is_symlink() or not prime_path.is_file():
                    raise RuntimeError("missing or unsafe bound Prime JSONL")
                prime = prime_path.read_bytes()
                digests = stored.get("sourceEntryDigests")
                locators = stored.get("sourceLocators")
                if not isinstance(digests, list) or not isinstance(locators, list) or len(digests) != len(locators):
                    raise RuntimeError("invalid DSH source locators")
                source: list[Any] = []
                for index, (entry_digest, locator) in enumerate(zip(digests, locators)):
                    if (not isinstance(entry_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", entry_digest)
                            or not isinstance(locator, dict) or locator.get("index") != index
                            or locator.get("entryDigest") != entry_digest):
                        raise RuntimeError("invalid DSH source locator")
                    offset, length = locator.get("byteOffset"), locator.get("byteLength")
                    if (not isinstance(offset, int) or isinstance(offset, bool) or offset < 0
                            or not isinstance(length, int) or isinstance(length, bool) or length <= 0
                            or offset + length > len(prime)):
                        raise RuntimeError("invalid DSH source locator bounds")
                    end = offset + length
                    if ((offset > 0 and prime[offset - 1] != 0x0A)
                            or (end < len(prime) and prime[end] != 0x0A
                                and not (prime[end] == 0x0D and end + 1 < len(prime) and prime[end + 1] == 0x0A))):
                        raise RuntimeError("DSH source locator is not a complete JSONL line")
                    try:
                        value = json.loads(prime[offset:offset + length])
                    except (UnicodeDecodeError, json.JSONDecodeError) as error:
                        raise RuntimeError("invalid located Prime JSONL entry") from error
                    if sha256(_canonical_json(value)).hexdigest() != entry_digest:
                        raise RuntimeError("bound Prime JSONL entry digest mismatch")
                    entry_id = locator.get("entryId")
                    if entry_id is not None and (not isinstance(value, dict) or value.get("id") != entry_id):
                        raise RuntimeError("bound Prime JSONL entry id mismatch")
                    source.append(value)
                if sha256(_canonical_json(source)).hexdigest() != stored.get("sourceDigest"):
                    raise RuntimeError("DSH source aggregate digest mismatch")
                refs = stored.get("effectiveReferences")
                effective_digests = stored.get("effectiveEntryDigests")
                if not isinstance(refs, list) or not isinstance(effective_digests, list) or len(refs) != len(effective_digests):
                    raise RuntimeError("invalid DSH effective references")
                messages: list[Any] = []
                unavailable = 0
                for index, (reference, expected_digest) in enumerate(zip(refs, effective_digests)):
                    if not isinstance(reference, dict) or reference.get("entryDigest") != expected_digest:
                        raise RuntimeError("invalid DSH effective reference")
                    source_index = reference.get("sourceIndex")
                    if source_index is None:
                        unavailable += 1
                        continue
                    if not isinstance(source_index, int) or isinstance(source_index, bool) or not 0 <= source_index < len(source):
                        raise RuntimeError("invalid DSH effective source index")
                    entry = source[source_index]
                    message = entry.get("message", entry) if isinstance(entry, dict) else entry
                    if not isinstance(message, dict):
                        continue
                    message = dict(message)
                    if isinstance(message.get("content"), str):
                        message["content"] = [{"type": "text", "text": message["content"]}]
                    messages.append(message)
                def entry_text(value: Any) -> str:
                    if isinstance(value, dict):
                        message = value.get("message")
                        candidate = message if isinstance(message, dict) else value
                        content = candidate.get("content")
                        if isinstance(content, str):
                            return content
                        if isinstance(content, list):
                            return _message_text({"content": content})
                        if isinstance(candidate.get("summary"), str):
                            return candidate["summary"]
                    return json.dumps(value, ensure_ascii=False, sort_keys=True)
                entries = [{**value, "index": index, "text": entry_text(value)} if isinstance(value, dict)
                           else {"index": index, "text": entry_text(value), "value": value}
                           for index, value in enumerate(source)]
                if compatibility.get("messageCount") != len(refs) or compatibility.get("entries") != [] or "messages" in compatibility:
                    raise RuntimeError("invalid DSH reference-only compatibility view")
                compatibility = {**compatibility, "entries": entries, "messages": messages,
                                 "unavailableEffectiveEntries": unavailable}
            elif durable_version == "prime-agent-dsh/derived-object-v2":
                def read_bodies(field: str, aggregate: str) -> list[Any]:
                    digests = stored.get(field)
                    if not isinstance(digests, list) or not all(isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}", item) for item in digests):
                        raise RuntimeError("invalid DSH durable context body references")
                    values: list[Any] = []
                    canonical_bodies: list[bytes] = []
                    for body_digest in digests:
                        body_path = self.root / "bodies" / f"{body_digest}.json"
                        if body_path.is_symlink() or not body_path.is_file():
                            raise RuntimeError("missing or unsafe DSH durable context body")
                        body_raw = body_path.read_bytes().rstrip(b"\n")
                        if sha256(body_raw).hexdigest() != body_digest:
                            raise RuntimeError("DSH durable context body digest mismatch")
                        try:
                            values.append(json.loads(body_raw))
                        except (UnicodeDecodeError, json.JSONDecodeError) as error:
                            raise RuntimeError("invalid DSH durable context body") from error
                        canonical_bodies.append(body_raw)
                    aggregate_raw = b"[" + b",".join(canonical_bodies) + b"]"
                    if sha256(aggregate_raw).hexdigest() != stored.get(aggregate):
                        raise RuntimeError("DSH durable aggregate context digest mismatch")
                    return values

                read_bodies("sourceEntryDigests", "sourceDigest")
                messages = read_bodies("effectiveEntryDigests", "effectiveDigest")
                if compatibility.get("messageCount") != len(messages) or "messages" in compatibility:
                    raise RuntimeError("invalid DSH durable context compatibility view")
                compatibility = {**compatibility, "messages": messages}
            data = {**compatibility, "version": _VERSION, "metrics": compatibility.get("metrics", manifest.get("metrics", {}))}
        elif isinstance(stored, dict) and stored.get("version") == _VERSION:
            data = stored
        else:
            raise RuntimeError("invalid DSH context snapshot")
        snapshot = ContextSnapshot(self.root, manifest, data)
        if expected_branch_id is not None and snapshot.branch_id != expected_branch_id:
            raise RuntimeError("DSH context snapshot branch mismatch")
        return snapshot

    def entries(self, *args: Any, **kwargs: Any) -> ContextSelection:
        return self.snapshot().entries(*args, **kwargs)

    def messages(self, *args: Any, **kwargs: Any) -> ContextSelection:
        return self.snapshot().messages(*args, **kwargs)

    def search(self, *args: Any, **kwargs: Any) -> ContextSelection:
        return self.snapshot().search(*args, **kwargs)

    @property
    def metrics(self) -> dict[str, Any]:
        return dict(self.snapshot().metrics)

    def artifact(self, value: Any, label: str = "context") -> ContextArtifact:
        if not isinstance(label, str) or not label.strip():
            raise ValueError("label must be a non-empty string")
        body = f"# {label.strip()}\n\n{_render(value)}\n"
        raw = body.encode("utf-8")
        if len(raw) > _MAX_ARTIFACT_BYTES:
            raise ValueError(f"artifact exceeds {_MAX_ARTIFACT_BYTES} bytes")
        digest = sha256(raw).hexdigest()
        directory = self.root / "artifacts"
        _private_directory(directory)
        path = directory / f"{digest}.md"
        if path.exists() or path.is_symlink():
            if path.is_symlink() or not path.is_file() or sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"unsafe existing context artifact: {path}")
        else:
            _exclusive_write(path, raw)
        return ContextArtifact(path=path, digest=digest, bytes=len(raw))

    def inject(self, value: Any, label: str = "Selected DSH context", max_bytes: int = _MAX_INJECT_BYTES) -> str:
        """Return bounded context text; print/return it so Prime logs the IPython result."""
        if not isinstance(label, str) or not label.strip():
            raise ValueError("label must be a non-empty string")
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0 or max_bytes > _MAX_INJECT_BYTES:
            raise ValueError(f"max_bytes must be between 1 and {_MAX_INJECT_BYTES}")
        rendered = _crop_utf8(_render(value), max_bytes)
        return f"<dsh-context label={json.dumps(label.strip(), ensure_ascii=False)}>\n{rendered}\n</dsh-context>"

    admit = inject

    def grant(
        self,
        value: Any,
        label: str = "Shared parent context",
        *,
        ttl_seconds: int = 24 * 60 * 60,
    ) -> ContextGrant:
        """Create a bounded read-only grant that a descendant can open by token."""
        if not isinstance(label, str) or not label.strip():
            raise ValueError("label must be a non-empty string")
        if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or ttl_seconds <= 0 or ttl_seconds > _MAX_GRANT_TTL_SECONDS:
            raise ValueError(f"ttl_seconds must be between 1 and {_MAX_GRANT_TTL_SECONDS}")
        selection_digest = value.digest if isinstance(value, ContextSelection) else None
        snapshot = self.snapshot(selection_digest)
        now = int(time.time())
        token = secrets.token_urlsafe(32)
        record = {
            "version": _GRANT_VERSION,
            "token": token,
            "label": label.strip(),
            "sourceSessionId": snapshot.session_id,
            "sourceBranchId": snapshot.branch_id,
            "sourceSnapshotDigest": snapshot.digest,
            "createdAt": now,
            "expiresAt": now + ttl_seconds,
            "value": _jsonable(value),
        }
        payload = _canonical_json(record)
        if len(payload) > _MAX_GRANT_BYTES:
            raise ValueError(f"context grant exceeds {_MAX_GRANT_BYTES} bytes")
        digest = sha256(payload).hexdigest()
        encoded = _canonical_json({**record, "digest": digest}) + b"\n"
        directory = self.root / "grants"
        _private_directory(directory)
        _exclusive_write(directory / f"{token}.json", encoded)
        return ContextGrant(token=token, digest=digest, expires_at=record["expiresAt"], label=label.strip())

    def __repr__(self) -> str:
        try:
            return f"ContextHandle({self.snapshot()!r})"
        except Exception as error:
            return f"ContextHandle(unavailable={error!r})"


def _grant_token(value: str) -> str:
    prefix = "dsh-context-grant:"
    token = value[len(prefix) :] if value.startswith(prefix) else value
    if not _GRANT_TOKEN.fullmatch(token):
        raise ValueError("invalid DSH context grant token")
    return token


def open_grant(value: str) -> GrantedContext:
    """Open a capability grant from this session or one of its ancestors."""
    token = _grant_token(value)
    for ancestor in (_session_dir(), *_session_dir().parents):
        candidate = ancestor / "dsh-context" / "grants" / f"{token}.json"
        if not candidate.exists() and not candidate.is_symlink():
            continue
        if candidate.is_symlink() or not candidate.is_file():
            raise RuntimeError(f"unsafe DSH context grant path: {candidate}")
        record = _read_json(candidate)
        if record.get("version") != _GRANT_VERSION or record.get("token") != token:
            raise RuntimeError("invalid DSH context grant")
        supplied = record.get("digest")
        unsigned = {key: item for key, item in record.items() if key != "digest"}
        if not isinstance(supplied, str) or sha256(_canonical_json(unsigned)).hexdigest() != supplied:
            raise RuntimeError("DSH context grant digest mismatch")
        expires_at = record.get("expiresAt")
        if not isinstance(expires_at, int) or expires_at < int(time.time()):
            raise RuntimeError("DSH context grant has expired")
        required = ("label", "sourceSessionId", "sourceBranchId", "sourceSnapshotDigest", "createdAt")
        if any(not isinstance(record.get(key), (str if key != "createdAt" else int)) for key in required):
            raise RuntimeError("invalid DSH context grant fields")
        return GrantedContext(
            token=token,
            label=record["label"],
            source_session_id=record["sourceSessionId"],
            source_branch_id=record["sourceBranchId"],
            source_snapshot_digest=record["sourceSnapshotDigest"],
            created_at=record["createdAt"],
            expires_at=expires_at,
            value=record.get("value"),
        )
    raise FileNotFoundError(f"DSH context grant {token!r} is not reachable from this session")


def current() -> ContextHandle:
    """Return the current Prime session's lazy DSH context handle."""
    return ContextHandle(_private_root())


__all__ = [
    "ContextArtifact",
    "ContextGrant",
    "ContextHandle",
    "ContextItem",
    "ContextSelection",
    "ContextSnapshot",
    "GrantedContext",
    "current",
    "open_grant",
]
