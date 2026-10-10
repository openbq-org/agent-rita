/**
 * After a client tool result (here describe_table), qwen3.6-35b sometimes
 * finishes its reasoning ("now I'm building the arrange_table call") and stops
 * with no text and no tool call. The request is a tool re-POST and no tool ran
 * in it, so terminalToolStop stayed quiet and the stream ended empty. The loop
 * retries that empty step once, like a suggestions-only one; a second empty
 * reply passes through, so there is no loop.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop, _resetWidgetDataCache } from "../../../src/agent/loop";
import type { AgentTool, QueryRequest, SSEEvent, ToolMessage } from "../../../src/protocol/types";
import { llmCallsTool, llmEmitsText, makeSequencedSpyMockLlm, type LlmStep } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => {
  clearAllModuleState();
  _resetWidgetDataCache();
});

const empty: LlmStep = llmEmitsText("");
const arrange = { card_id: "w", expected_revision: "tm1" };

function tools(): AgentTool[] {
  return ["describe_table", "arrange_table"].map((name) => ({
    name,
    server_id: "client-local",
    url: "",
    description: name,
    input_schema: { properties: { card_id: { type: "string" }, expected_revision: { type: "string" } }, required: ["card_id"] },
  }));
}

/** The client's re-POST after it ran describe_table. */
const described = {
  role: "tool",
  function: "execute_agent_tool",
  input_arguments: { tool_name: "describe_table", server_id: "client-local", parameters: { card_id: "w" } },
  data: [{ items: [{ type: "text", text: JSON.stringify({ status: "ok", revision: "tm1" }) }] }],
} as unknown as ToolMessage;

async function run(messages: unknown[], steps: LlmStep[]) {
  const spy = makeSequencedSpyMockLlm(steps);
  const events = await collectGenerator(
    runAgentLoop({
      request: { messages, tools: tools() } as unknown as QueryRequest,
      rawModelId: "openai:gpt-4o-mini",
      model: spy.model,
      allWidgets: [],
      workspaceState: null,
      generativeUiEnabled: false,
      conversationId: "empty-step",
    }),
  );
  return { calls: spy.calls.length, events };
}

function agentToolCalls(events: SSEEvent[]): string[] {
  return events
    .filter((e) => e.event === "copilotFunctionCall" && (e.data as { function?: string }).function === "execute_agent_tool")
    .map((e) => (e.data as { input_arguments: { tool_name: string } }).input_arguments.tool_name);
}

const human = { role: "human", content: "Show total Amount by Region in the table." };

describe("empty step retry", () => {
  it("retries an empty step right after a client tool result and emits the retry's call", async () => {
    const { calls, events } = await run([human, described], [empty, llmCallsTool("arrange_table", arrange)]);
    expect(calls).toBe(2);
    expect(agentToolCalls(events)).toEqual(["arrange_table"]);
  });

  it("retries an empty first step of a turn too", async () => {
    const { calls, events } = await run([human], [empty, llmCallsTool("describe_table", { card_id: "w" })]);
    expect(calls).toBe(2);
    expect(agentToolCalls(events)).toEqual(["describe_table"]);
  });

  it("passes a second empty reply through (no loop)", async () => {
    const { calls, events } = await run([human, described], [empty, empty]);
    expect(calls).toBe(2);
    expect(agentToolCalls(events)).toEqual([]);
  });

  it("does not retry when there is answer text", async () => {
    const { calls } = await run([human, described], [llmEmitsText("Region is text, so it cannot be summed.")]);
    expect(calls).toBe(1);
  });
});
