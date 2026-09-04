import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createPrimeUserQuestionAnswerer, rejectHeadlessUserQuestion } from "../src/prime-user-questions.js";

const ui = (overrides: Partial<ExtensionUIContext>): ExtensionUIContext => ({ ...overrides } as ExtensionUIContext);

test("maps choices, custom answers, and multiselect to DSH answer labels", async () => {
  const selections = ["1. A — first", "Other (type a custom answer)", "Done"];
  const answer = await createPrimeUserQuestionAnswerer(ui({
    select: async () => selections.shift(), input: async () => "extra",
  }))({ questions: [{ id: "q", question: "Pick", options: [{ label: "A", description: "first" }], multiSelect: true }] });
  assert.deepEqual(answer, { answers: [{ id: "q", selected: ["A"], custom: "extra" }] });
});

test("renders plan-review detail through Prime confirmation", async () => {
  let message = "";
  const answer = await createPrimeUserQuestionAnswerer(ui({ confirm: async (_title, detail) => { message = detail; return false; } }))({
    questions: [{ id: "plan-review", question: "Approve?", detail: "# Plan\nDo it", options: [{ label: "Approve" }, { label: "Keep planning" }], intent: { kind: "plan-review", approve: "Approve" } }],
  });
  assert.equal(message, "# Plan\nDo it");
  assert.deepEqual(answer.answers[0]?.selected, ["Keep planning"]);
});

test("headless answerer fails closed", async () => {
  await assert.rejects(rejectHeadlessUserQuestion({ questions: [{ id: "q", question: "?" }] }), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "NO_UI");
});
