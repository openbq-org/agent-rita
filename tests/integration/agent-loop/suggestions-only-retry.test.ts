/**
 * On a first-turn tool request, qwen3.6-35b sometimes reasons "let me
 * search for the widget" and then emits only a <suggestions> block and stops,
 * with no tool call. The loop retries that step once — only when nothing but
 * whitespace + a suggestions block came back, no tool ran this turn, and it is
 * the first model call of the request. A second suggestions-only reply passes
 * through unchanged, so there is no loop.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent } from "../../../src/protocol/types";
import { llmCallsTool, llmEmitsText, makeSequencedSpyMockLlm, type LlmStep } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

const suggestionsOnly = (s: string): LlmStep =>
  llmEmitsText(`\n\n<suggestions>\n<suggestion>${s}</suggestion>\n</suggestions>`);

async function run(steps: LlmStep[]) {
  const spy = makeSequencedSpyMockLlm(steps);
  const events = await collectGenerator(
    runAgentLoop({
      request: { messages: [{ role: "human", content: "add an AAPL chart" }] } as QueryRequest,
      rawModelId: "openai:gpt-4o-mini",
      model: spy.model,
      allWidgets: [],
      workspaceState: null,
      generativeUiEnabled: false,
      promptSuggestionsEnabled: true,
      conversationId: "d016",
    }),
  );
  return { calls: spy.calls.length, events };
}

function text(events: SSEEvent[]): string {
  return events
    .filter((e) => e.event === "copilotMessageChunk")
    .map((e) => (e.data as { delta: string }).delta)
    .join("");
}

function suggestions(events: SSEEvent[]): string[][] {
  return events
    .filter((e) => e.event === "copilotPromptSuggestions")
    .map((e) => (e.data as { suggestions: string[] }).suggestions);
}

describe("suggestions-only step retry", () => {
  it("retries a suggestions-only first step once and keeps the retry's answer", async () => {
    const { calls, events } = await run([
      suggestionsOnly("Stale"),
      llmEmitsText("Done.\n\n<suggestions>\n<suggestion>Fresh</suggestion>\n</suggestions>"),
    ]);
    expect(calls).toBe(2);
    expect(text(events)).toContain("Done.");
    expect(suggestions(events)).toEqual([["Fresh"]]);
  });

  it("passes a second suggestions-only reply through as today (no loop)", async () => {
    const { calls, events } = await run([suggestionsOnly("First"), suggestionsOnly("Second")]);
    expect(calls).toBe(2);
    expect(suggestions(events)).toEqual([["Second"]]);
  });

  it("does not retry when there is real answer text", async () => {
    const { calls, events } = await run([
      llmEmitsText("Here you go.\n\n<suggestions>\n<suggestion>Next</suggestion>\n</suggestions>"),
    ]);
    expect(calls).toBe(1);
    expect(suggestions(events)).toEqual([["Next"]]);
  });

  it("does not retry after a tool already ran this turn", async () => {
    const { calls, events } = await run([
      llmCallsTool("search_widgets", { query: "aapl" }),
      suggestionsOnly("After tool"),
    ]);
    expect(calls).toBe(2);
    expect(suggestions(events)).toEqual([["After tool"]]);
  });
});
