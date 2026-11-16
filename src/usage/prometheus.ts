import { q } from "../internal/slice.ts";
import type { CallSink } from "../serve/types.ts";
import { configError } from "./errors.ts";

// The HELP texts, word for word as the first server to export these series wrote them.
const CALLS_HELP =
  "MCP tool calls handled by this process since it started, by tool and outcome (ok|error; error includes labeled tool errors such as not-found, not only thrown handlers) — resets on restart, use rate()/increase()";
const LATENCY_HELP = "Wall-clock handler latency of MCP tool calls, by tool (all outcomes)";

const METRIC_PREFIX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Prometheus text-exposition label-value escaping; the backslash goes first. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface ToolSeries {
  ok: number;
  error: number;
  sumSeconds: number;
  /** Cumulative counts, parallel to the buckets. */
  buckets: number[];
}

export type PrometheusToolMetrics = CallSink & {
  /** `<prefix>_calls_total` and `<prefix>_latency_seconds`, tools sorted, ending in a newline. */
  render(): string;
};

/**
 * A call counter and latency histogram per tool, in process: it resets on
 * restart, so read it with rate()/increase(). A tool gets its zero series
 * when it is registered, so a dead tool reads 0, not absent. Only calls a
 * handler ran are counted (`stage: "handler"`), and only for registered
 * tools, so a client cannot mint a label by calling a made-up name. Outcome
 * `error` is any call with `ok` false, a labeled error included. Latency is
 * the call's `durationMs`.
 */
export function prometheusToolMetrics(o: {
  prefix: string;
  /** Upper bounds in seconds, ascending. */
  latencyBuckets: readonly number[];
}): PrometheusToolMetrics {
  if (typeof o.prefix !== "string" || !METRIC_PREFIX.test(o.prefix)) {
    throw configError(`prometheusToolMetrics: prefix must be a metric name — got ${q(o.prefix)}`);
  }
  const bounds = o.latencyBuckets;
  const ascending =
    Array.isArray(bounds) &&
    bounds.length > 0 &&
    bounds.every(
      (b, i) =>
        typeof b === "number" &&
        Number.isFinite(b) &&
        b > 0 &&
        (i === 0 || b > (bounds[i - 1] as number)),
    );
  if (!ascending) {
    throw configError(
      `prometheusToolMetrics: latencyBuckets must be ascending positive finite numbers — got ${q(bounds)}`,
    );
  }
  const buckets = Object.freeze([...bounds]);
  const { prefix } = o;
  const series = new Map<string, ToolSeries>();

  return {
    onRegister(tool) {
      if (!series.has(tool)) {
        series.set(tool, {
          ok: 0,
          error: 0,
          sumSeconds: 0,
          buckets: buckets.map(() => 0),
        });
      }
    },
    record(r) {
      if (r.stage !== "handler") return;
      const s = series.get(r.tool);
      if (s === undefined) return;
      // Not a finite number: counted as 0, as the call log stores it.
      const ms = Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0;
      const seconds = ms / 1000;
      s[r.ok ? "ok" : "error"] += 1;
      s.sumSeconds += seconds;
      buckets.forEach((bound, i) => {
        if (seconds <= bound) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
      });
    },
    render() {
      const calls = `${prefix}_calls_total`;
      const latency = `${prefix}_latency_seconds`;
      const callLines = [`# HELP ${calls} ${CALLS_HELP}`, `# TYPE ${calls} counter`];
      const latencyLines = [`# HELP ${latency} ${LATENCY_HELP}`, `# TYPE ${latency} histogram`];
      const tools = [...series.keys()].sort((a, b) => a.localeCompare(b));
      for (const name of tools) {
        const s = series.get(name) as ToolSeries;
        const tool = escapeLabelValue(name);
        const count = s.ok + s.error;
        for (const outcome of ["ok", "error"] as const) {
          callLines.push(`${calls}{tool="${tool}",outcome="${outcome}"} ${s[outcome]}`);
        }
        buckets.forEach((bound, i) => {
          latencyLines.push(`${latency}_bucket{tool="${tool}",le="${bound}"} ${s.buckets[i] ?? 0}`);
        });
        latencyLines.push(
          `${latency}_bucket{tool="${tool}",le="+Inf"} ${count}`,
          `${latency}_sum{tool="${tool}"} ${s.sumSeconds}`,
          `${latency}_count{tool="${tool}"} ${count}`,
        );
      }
      return `${callLines.join("\n")}\n\n${latencyLines.join("\n")}\n`;
    },
  };
}
