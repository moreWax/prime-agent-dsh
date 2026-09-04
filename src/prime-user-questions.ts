import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";

type UserQuestionAnswerer = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>;

function cancelled(): never {
  throw new UserQuestionError("the user cancelled ask_user_question", "ASK_CANCELLED");
}

function titleOf(question: AskUserQuestionItem): string {
  return question.header ? `${question.header}: ${question.question}` : question.question;
}

function optionRows(question: AskUserQuestionItem): { rows: string[]; labelByRow: Map<string, string> } {
  const labelByRow = new Map<string, string>();
  const rows = (question.options ?? []).map((option, index) => {
    const row = option.description ? `${option.label} — ${option.description}` : option.label;
    // A numeric prefix makes rows unambiguous even when a description produces
    // the same display string as another option.
    const unique = `${index + 1}. ${row}`;
    labelByRow.set(unique, option.label);
    return unique;
  });
  return { rows, labelByRow };
}

async function askOne(ui: ExtensionUIContext, question: AskUserQuestionItem, signal?: AbortSignal): Promise<AskUserQuestionAnswerItem> {
  const title = titleOf(question);
  const { rows, labelByRow } = optionRows(question);
  const opts = signal ? { signal } : undefined;

  if (rows.length === 0) {
    const custom = await ui.input(title, question.detail ?? "Type your answer", opts);
    if (custom === undefined) cancelled();
    return { id: question.id, selected: [], custom };
  }

  if (question.intent?.kind === "plan-review" && question.detail !== undefined && rows.length <= 2 && question.multiSelect !== true) {
    const approved = await ui.confirm(title, question.detail, opts);
    const decline = (question.options ?? []).find((option) => option.label !== question.intent?.approve);
    const selected = approved ? question.intent.approve : decline?.label;
    if (selected === undefined) cancelled();
    return { id: question.id, selected: [selected] };
  }

  if (question.multiSelect === true) {
    const selected: string[] = [];
    let custom: string | undefined;
    const remaining = new Set(rows);
    while (true) {
      const choices = [...remaining, "Done", "Other (type a custom answer)"];
      const choice = await ui.select(`${title}${selected.length ? ` [selected: ${selected.join(", ")}]` : ""}`, choices, opts);
      if (choice === undefined) cancelled();
      if (choice === "Done") break;
      if (choice === "Other (type a custom answer)") {
        const value = await ui.input(title, question.detail ?? "Type another answer", opts);
        if (value === undefined) cancelled();
        custom = value;
        continue;
      }
      const label = labelByRow.get(choice);
      if (label === undefined) throw new UserQuestionError("Prime UI returned an unknown choice", "BAD_ANSWER");
      selected.push(label);
      remaining.delete(choice);
    }
    return custom === undefined ? { id: question.id, selected } : { id: question.id, selected, custom };
  }

  const other = "Other (type a custom answer)";
  const choice = await ui.select(title, [...rows, other], opts);
  if (choice === undefined) cancelled();
  if (choice === other) {
    const custom = await ui.input(title, question.detail ?? "Type your answer", opts);
    if (custom === undefined) cancelled();
    return { id: question.id, selected: [], custom };
  }
  const label = labelByRow.get(choice);
  if (label === undefined) throw new UserQuestionError("Prime UI returned an unknown choice", "BAD_ANSWER");
  return { id: question.id, selected: [label] };
}

/** Adapt DSH structured questions (including plan-review intent) to Prime dialogs. */
export function createPrimeUserQuestionAnswerer(ui: ExtensionUIContext): UserQuestionAnswerer {
  return async (request) => {
    const answers: AskUserQuestionAnswerItem[] = [];
    for (const question of request.questions) answers.push(await askOne(ui, question, request.signal));
    return { answers };
  };
}

/** Headless runs must reject rather than leave a DSH turn waiting forever. */
export const rejectHeadlessUserQuestion: UserQuestionAnswerer = () => Promise.reject(
  new UserQuestionError("ask_user_question requires an interactive Prime UI", "NO_UI"),
);
