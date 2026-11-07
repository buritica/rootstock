import type { Sql } from "../db/index.ts";
import { perSlice } from "../internal/slice.ts";
import { guarded } from "./errors.ts";
import { type Emit, emitter, type QueueHooks } from "./events.ts";
import { refuse, text } from "./input.ts";
import { assertCursorTable, type CursorTable } from "./slice.ts";
import { type CursorStatements, cursorStatements } from "./statements.ts";

/** A string for a text table; any JSON value for a jsonb table. */
export type CursorValue = unknown;

/** The table's statements, after the brand check, built once per table. */
const statementsOf = perSlice(
  assertCursorTable,
  (t: CursorTable): CursorStatements => cursorStatements(t.table, t.value),
);

/** The value as the text bound to `$2`: the string itself, or its JSON. */
function bound(emit: Emit, t: CursorTable, value: CursorValue): string {
  if (t.value === "text") {
    return text(emit, value, t.maxValueChars, "cursor value", "cursor_value_invalid");
  }
  const bad =
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value));
  let json: string | undefined;
  if (!bad) {
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
  }
  if (json === undefined) {
    throw refuse(emit, "cursor_value_invalid", "cursor value must be a JSON value");
  }
  if (json.length > t.maxValueChars) {
    throw refuse(
      emit,
      "cursor_value_invalid",
      `cursor value is ${json.length} characters, over the ${t.maxValueChars} cap`,
      { size: json.length },
    );
  }
  return json;
}

const read = (t: CursorTable, v: unknown): CursorValue =>
  t.value === "text" ? String(v) : JSON.parse(String(v));

/** K1. The cursor's value, or undefined when it has none. */
export async function getCursor(
  sql: Sql,
  t: CursorTable,
  name: string,
  hooks?: QueueHooks,
): Promise<CursorValue | undefined> {
  const st = statementsOf("getCursor", t);
  const emit = emitter(hooks);
  const n = text(emit, name, t.maxNameChars, "cursor name", "cursor_name_invalid");
  const [row] = await guarded(t.table, () => sql.unsafe(st.get, [n]));
  const value = row === undefined || row.value === null ? undefined : read(t, row.value);
  emit({ type: "queue.cursor_read", name: n, value: value ?? null });
  return value;
}

/** K2. Writes the cursor and reports what it moved from. */
export async function setCursor(
  sql: Sql,
  t: CursorTable,
  name: string,
  value: CursorValue,
  hooks?: QueueHooks,
): Promise<void> {
  const st = statementsOf("setCursor", t);
  const emit = emitter(hooks);
  const n = text(emit, name, t.maxNameChars, "cursor name", "cursor_name_invalid");
  const v = bound(emit, t, value);
  const [row] = await guarded(t.table, () => sql.unsafe(st.set, [n, v]));
  const previous = row?.previous;
  emit({
    type: "queue.cursor_written",
    name: n,
    from: previous === null || previous === undefined ? null : read(t, previous),
    to: value,
  });
}

/**
 * K3. Inserts the cursor with `initial` the first time; afterwards only moves
 * its `updated_at`, never its value. A pulse: it emits no event.
 */
export async function touchCursor(
  sql: Sql,
  t: CursorTable,
  name: string,
  initial: CursorValue,
): Promise<void> {
  const st = statementsOf("touchCursor", t);
  const emit = emitter(undefined);
  const n = text(emit, name, t.maxNameChars, "cursor name", "cursor_name_invalid");
  const v = bound(emit, t, initial);
  await guarded(t.table, () => sql.unsafe(st.touch, [n, v]));
}
