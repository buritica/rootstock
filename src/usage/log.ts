import type { LogEvent } from "../serve/types.ts";

/** `log`, made safe to call anywhere: what it throws is dropped, so logging never changes what its caller does. */
export function guardedLog(log: LogEvent): LogEvent {
  return (event, fields) => {
    try {
      log(event, fields);
    } catch {
      // Dropped, as above.
    }
  };
}
