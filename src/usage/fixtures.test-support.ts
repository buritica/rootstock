import type { CallRecord, Clock } from "../serve/types.ts";

/** A handler call of the synthetic `echo` tool; override any field. */
export function callRecord(over: Partial<CallRecord> = {}): CallRecord {
  return {
    stage: "handler",
    caller: "user-1",
    onBehalfOf: null,
    turnId: null,
    tool: "echo",
    args: { text: "hi" },
    durationMs: 12,
    ok: true,
    errorClass: null,
    errorMessage: null,
    resultIds: null,
    phases: null,
    tokens: null,
    costUsd: null,
    costNote: null,
    outputText: null,
    extra: null,
    serverSha: null,
    clientUa: null,
    mcpProtocol: null,
    ...over,
  };
}

/** Captured log events. */
export function captureLog(): {
  events: { event: string; fields: Readonly<Record<string, unknown>> }[];
  log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
} {
  const events: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  return { events, log: (event, fields) => events.push({ event, fields }) };
}

/** A clock the test moves by hand. */
export function manualClock(start = 1_700_000_000_000): Clock & { set(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    monotonic: () => t,
    set: (ms) => {
      t = ms;
    },
  };
}
