/** One cursor-paginated Slack Web API method, described entirely by its caller. */
export interface SlackCursorWalk {
  /** Prefix of every refusal this walk raises, e.g. "svc: conversations.history". */
  readonly label: string;
  /** The array field concatenated across pages. */
  readonly key: string;
  readonly maxPages: number;
  readonly fetchPage: (cursor: string | undefined) => Promise<Record<string, unknown>>;
  /** Builds each refusal; the result is thrown exactly as returned. */
  readonly makeError: (message: string) => Error;
}

/**
 * Cursor-paginate a method, concatenating the `key` array from each page.
 * A repeated cursor or a run past `maxPages` is upstream misbehavior and
 * fails loudly instead of looping forever on someone else's bug.
 */
export async function paginateSlackCursor(walk: SlackCursorWalk): Promise<unknown[]> {
  const { label, key, maxPages, fetchPage, makeError } = walk;
  const all: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      throw makeError(`${label} exceeded ${maxPages} pages — refusing to loop`);
    }
    const body = await fetchPage(cursor);
    const items = body[key];
    if (!Array.isArray(items)) {
      // ok:true with a missing/renamed key would otherwise read as "nothing
      // here" and quietly shrink the corpus.
      throw makeError(`${label} returned ok but no ${JSON.stringify(key)} array`);
    }
    all.push(...items);
    const next = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (next === undefined || next === "") return all;
    if (seenCursors.has(next)) {
      throw makeError(`${label} repeated pagination cursor — refusing to loop`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}
