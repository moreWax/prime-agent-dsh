
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSeedEvents,
  seedSession,
  toText,
  transcriptFromMessages,
  type SeedableSession,
  type TranscriptMessage,
} from "../src/context-seed.js";

test("transcriptFromMessages keeps only surface user/assistant text", () => {
  const out = transcriptFromMessages([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: "a reply" },
    { role: "tool", content: "ignore-me" },
    { role: "user", content: "" },
    { role: "user", content: [{ type: "image", data: "x" }] },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "a reply" },
  ]);
});

test("buildSeedEvents mirrors the agent-log append contract", () => {
  const events = buildSeedEvents([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi back" },
  ]);
  assert.equal(events[0]?.type, "user/message");
  assert.equal((events[0]?.data as { content: Array<{ text: string }> }).content[0]?.text, "hello");
  assert.equal(events[1]?.type, "assistant/message");
  assert.equal((events[1]?.data as { turn: number; step: number }).turn, 0);
});

test("seedSession appends events in order and reports the count", () => {
  const appended: unknown[] = [];
  const session: SeedableSession = {
    seq: 0,
    append: (event) => { appended.push(event); (session as { seq: number }).seq++; },
  };
  const count = seedSession(session, [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ] as TranscriptMessage[]);
  assert.equal(count, 3);
  assert.equal(appended.length, 3);
});

test("seedSession is best-effort: a host that rejects appends stays blank, no throw", () => {
  const session = { seq: 0, append: () => { throw new Error("format drift"); } } as SeedableSession;
  assert.equal(seedSession(session, [{ role: "user", content: "x" }] as TranscriptMessage[]), 0);
});

test("toText flattens string and block content", () => {
  assert.equal(toText("plain"), "plain");
  assert.equal(toText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(toText([{ type: "image" }] as never), "");
});
