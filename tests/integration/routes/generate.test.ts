/**
 * Tier 2 — /v1/generate/* routes (chat-title, dashboard-title,
 * enhance_prompt, widget_info, widget_info/file, code).
 *
 * Subsumes the prior plans/generate-tests.md scope.
 *
 * Strategy: mock ../../../src/lib/llm at module load to control
 * singleShotLlm responses without hitting a real provider. Real impls of
 * parseJsonResponse + truncate are reimplemented here (they're a few
 * lines and used by the routes).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

let nextLlm: () => Promise<string> = async () => "default";

mock.module("../../../src/lib/llm", () => ({
  singleShotLlm: async () => nextLlm(),
  parseJsonResponse: <T>(raw: string, fallback: T): T => {
    const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  },
  truncate: (s: string, max: number) => (s.length > max ? s.slice(0, max) + "..." : s),
}));

const { Hono } = await import("hono");
const { chatTitleRouter } = await import("../../../src/routes/generate/chat-title");
const { dashboardTitleRouter } = await import("../../../src/routes/generate/dashboard-title");
const { enhancePromptRouter } = await import("../../../src/routes/generate/enhance-prompt");
const { widgetInfoRouter } = await import("../../../src/routes/generate/widget-info");
const { codeRouter } = await import("../../../src/routes/generate/code");

function app() {
  const a = new Hono();
  a.route("/", chatTitleRouter);
  a.route("/", dashboardTitleRouter);
  a.route("/", enhancePromptRouter);
  a.route("/", widgetInfoRouter);
  a.route("/", codeRouter);
  return a;
}

beforeEach(() => {
  nextLlm = async () => "default";
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/v1/generate/chat/title", () => {
  it("strips surrounding quotes from the LLM response and returns plain JSON string", async () => {
    nextLlm = async () => '"AAPL Earnings Q3"';
    const res = await postJson("/v1/generate/chat/title", {
      messages: [{ role: "human", content: "tell me about AAPL earnings" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("AAPL Earnings Q3");
  });

  it("returns 'New Chat' fallback when no human messages are present", async () => {
    const res = await postJson("/v1/generate/chat/title", {
      messages: [{ role: "ai", content: "x" }],
    });
    expect(await res.json()).toBe("New Chat");
  });

  it("returns 'New Chat' fallback when LLM throws", async () => {
    nextLlm = async () => {
      throw new Error("provider down");
    };
    const res = await postJson("/v1/generate/chat/title", {
      messages: [{ role: "human", content: "hi" }],
    });
    expect(await res.json()).toBe("New Chat");
  });

  it("400 on schema violation", async () => {
    const res = await postJson("/v1/generate/chat/title", { messages: [] });
    expect(res.status).toBe(400);
  });
});

describe("/v1/generate/dashboard/title", () => {
  it("returns plain text title (not JSON-quoted)", async () => {
    nextLlm = async () => "Tech Pulse";
    const res = await postJson("/v1/generate/dashboard/title", {
      widgets: [{ name: "AAPL price" }, { name: "NVDA earnings" }],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Tech Pulse");
  });

  it("returns 'My Dashboard' fallback on empty widget names", async () => {
    const res = await postJson("/v1/generate/dashboard/title", {
      widgets: [{ description: "no name" }],
    });
    expect(await res.text()).toBe("My Dashboard");
  });

  it("400 on missing widgets", async () => {
    const res = await postJson("/v1/generate/dashboard/title", {});
    expect(res.status).toBe(400);
  });
});

describe("/v1/enhance_prompt", () => {
  it("returns enhanced prompt when human message + widgets are present", async () => {
    nextLlm = async () => "Show NVDA last 30 days returns";
    const res = await postJson("/v1/enhance_prompt", {
      messages: [{ role: "human", content: "nvda returns" }],
      widgets: { primary: [{ name: "NVDA price" }] },
    });
    expect(await res.text()).toBe("Show NVDA last 30 days returns");
  });

  it("returns the original prompt as fallback when LLM throws", async () => {
    nextLlm = async () => {
      throw new Error("boom");
    };
    const res = await postJson("/v1/enhance_prompt", {
      messages: [{ role: "human", content: "original" }],
    });
    expect(await res.text()).toBe("original");
  });

  it("returns empty string when there is no last human message", async () => {
    const res = await postJson("/v1/enhance_prompt", {
      messages: [{ role: "ai", content: "x" }],
    });
    expect(await res.text()).toBe("");
  });
});

describe("/v1/generate/widget_info", () => {
  it("parses LLM JSON response into the widget info shape", async () => {
    nextLlm = async () =>
      JSON.stringify({
        title: "AAPL Price",
        description: "Daily close",
        category: "Equity",
        subcategory: "Price History",
      });
    const res = await postJson("/v1/generate/widget_info", {
      widget_generation_request: {
        widget_data: '[{"close":100}]',
        metadata: { name: "Old Name", category: "Equity" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      description: string;
      category: string;
      subcategory: string;
    };
    expect(body.title).toBe("AAPL Price");
    expect(body.category).toBe("Equity");
  });

  it("falls back to metadata when LLM returns malformed JSON", async () => {
    nextLlm = async () => "not json";
    const res = await postJson("/v1/generate/widget_info", {
      widget_generation_request: {
        widget_data: "[]",
        metadata: { name: "M" },
        name: "Provided",
      },
    });
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Provided");
  });

  it("400 on missing widget_data", async () => {
    const res = await postJson("/v1/generate/widget_info", {
      widget_generation_request: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("/v1/generate/widget_info/file", () => {
  it("400 when no file is uploaded", async () => {
    const res = await app().request("/v1/generate/widget_info/file", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  });

  it("413 when file exceeds the 25MB cap", async () => {
    const fd = new FormData();
    const big = new Blob([new Uint8Array(26 * 1024 * 1024)], { type: "text/csv" });
    fd.append("file", new File([big], "big.csv"));
    const res = await app().request("/v1/generate/widget_info/file", {
      method: "POST",
      body: fd,
    });
    expect(res.status).toBe(413);
  });

  it("uses filename as title fallback when LLM JSON is malformed", async () => {
    nextLlm = async () => "garbage";
    const fd = new FormData();
    fd.append("file", new File(["a,b\n1,2"], "prices.csv", { type: "text/csv" }));
    const res = await app().request("/v1/generate/widget_info/file", {
      method: "POST",
      body: fd,
    });
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("prices");
  });
});

describe("/v1/generate/code", () => {
  it("returns parsed code on success JSON", async () => {
    nextLlm = async () =>
      JSON.stringify({ success: true, generated_code: "SELECT 1" });
    const res = await postJson("/v1/generate/code", {
      widget_uuid: "w-1",
      user_prompt: "select one",
      language: "sql",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; generated_code: string };
    expect(body.success).toBe(true);
    expect(body.generated_code).toBe("SELECT 1");
  });

  it("returns failure shape when LLM throws", async () => {
    nextLlm = async () => {
      throw new Error("nope");
    };
    const res = await postJson("/v1/generate/code", {
      widget_uuid: "w-1",
      user_prompt: "x",
      language: "python",
    });
    const body = (await res.json()) as { success: boolean; error_message: string };
    expect(body.success).toBe(false);
    expect(body.error_message).toContain("Code generation failed");
  });

  it("400 on unknown language", async () => {
    const res = await postJson("/v1/generate/code", {
      widget_uuid: "w-1",
      user_prompt: "x",
      language: "rust",
    });
    expect(res.status).toBe(400);
  });
});

describe("/v1/generate/* — malformed (non-JSON) body", () => {
  for (const path of [
    "/v1/generate/chat/title",
    "/v1/generate/dashboard/title",
    "/v1/enhance_prompt",
    "/v1/generate/widget_info",
    "/v1/generate/code",
  ]) {
    it(`${path}: 400, not 500`, async () => {
      const res = await app().request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; details: unknown[] };
      expect(body.error).toBe("Invalid request");
      expect(body.details.length).toBeGreaterThan(0);
    });
  }
});
