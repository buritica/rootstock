import { describe, expect, test } from "bun:test";
import { usageErrorCode } from "./errors.ts";
import { callRecord } from "./fixtures.test-support.ts";
import { prometheusToolMetrics } from "./prometheus.ts";

const HELP_CALLS =
  "MCP tool calls handled by this process since it started, by tool and outcome (ok|error; error includes labeled tool errors such as not-found, not only thrown handlers) — resets on restart, use rate()/increase()";
const HELP_LATENCY = "Wall-clock handler latency of MCP tool calls, by tool (all outcomes)";

const make = () =>
  prometheusToolMetrics({ prefix: "app_mcp_tool", latencyBuckets: [0.01, 0.1, 1] });

describe("prometheusToolMetrics", () => {
  test("renders the series byte for byte, tools sorted, a registered tool at zero", () => {
    const m = make();
    m.onRegister?.("slow");
    m.onRegister?.("echo");
    m.onRegister?.("echo");
    m.record(callRecord({ tool: "echo", durationMs: 5 }));
    m.record(callRecord({ tool: "echo", durationMs: 50, ok: false, errorClass: "TypeError" }));
    m.record(callRecord({ tool: "echo", durationMs: 2500 }));
    expect(m.render()).toBe(
      [
        `# HELP app_mcp_tool_calls_total ${HELP_CALLS}`,
        "# TYPE app_mcp_tool_calls_total counter",
        'app_mcp_tool_calls_total{tool="echo",outcome="ok"} 2',
        'app_mcp_tool_calls_total{tool="echo",outcome="error"} 1',
        'app_mcp_tool_calls_total{tool="slow",outcome="ok"} 0',
        'app_mcp_tool_calls_total{tool="slow",outcome="error"} 0',
        "",
        `# HELP app_mcp_tool_latency_seconds ${HELP_LATENCY}`,
        "# TYPE app_mcp_tool_latency_seconds histogram",
        'app_mcp_tool_latency_seconds_bucket{tool="echo",le="0.01"} 1',
        'app_mcp_tool_latency_seconds_bucket{tool="echo",le="0.1"} 2',
        'app_mcp_tool_latency_seconds_bucket{tool="echo",le="1"} 2',
        'app_mcp_tool_latency_seconds_bucket{tool="echo",le="+Inf"} 3',
        'app_mcp_tool_latency_seconds_sum{tool="echo"} 2.555',
        'app_mcp_tool_latency_seconds_count{tool="echo"} 3',
        'app_mcp_tool_latency_seconds_bucket{tool="slow",le="0.01"} 0',
        'app_mcp_tool_latency_seconds_bucket{tool="slow",le="0.1"} 0',
        'app_mcp_tool_latency_seconds_bucket{tool="slow",le="1"} 0',
        'app_mcp_tool_latency_seconds_bucket{tool="slow",le="+Inf"} 0',
        'app_mcp_tool_latency_seconds_sum{tool="slow"} 0',
        'app_mcp_tool_latency_seconds_count{tool="slow"} 0',
        "",
      ].join("\n"),
    );
  });

  test("with no tool registered, only the HELP and TYPE lines", () => {
    expect(make().render()).toBe(
      `# HELP app_mcp_tool_calls_total ${HELP_CALLS}\n# TYPE app_mcp_tool_calls_total counter\n\n# HELP app_mcp_tool_latency_seconds ${HELP_LATENCY}\n# TYPE app_mcp_tool_latency_seconds histogram\n`,
    );
  });

  test("ignores an unknown tool, and rejected and refused calls", () => {
    const m = make();
    m.onRegister?.("echo");
    const before = m.render();
    m.record(callRecord({ tool: "made-up", stage: "handler" }));
    m.record(
      callRecord({ tool: "made-up", stage: "rejected", ok: false, errorClass: "UnknownTool" }),
    );
    m.record(
      callRecord({ tool: "echo", stage: "rejected", ok: false, errorClass: "InvalidParams" }),
    );
    m.record(callRecord({ tool: "echo", stage: "refused", ok: false, errorClass: "RateLimited" }));
    expect(m.render()).toBe(before);
    expect(m.render()).not.toContain("made-up");
  });

  test("escapes label values", () => {
    const m = make();
    m.onRegister?.('a"b\\c\nd');
    expect(m.render()).toContain('{tool="a\\"b\\\\c\\nd",outcome="ok"} 0');
  });

  test("refuses a bad prefix or buckets", () => {
    const bad = [
      { prefix: "1abc", latencyBuckets: [1] },
      { prefix: "a-b", latencyBuckets: [1] },
      { prefix: "ok", latencyBuckets: [] },
      { prefix: "ok", latencyBuckets: [1, 1] },
      { prefix: "ok", latencyBuckets: [0, 1] },
      { prefix: "ok", latencyBuckets: [1, Number.POSITIVE_INFINITY] },
    ];
    for (const o of bad) {
      let caught: unknown;
      try {
        prometheusToolMetrics(o);
      } catch (err) {
        caught = err;
      }
      expect(usageErrorCode(caught)).toBe("ERR_ROOTSTOCK_USAGE_CONFIG");
    }
  });
});
