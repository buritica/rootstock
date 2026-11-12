import { quoteIdentifier } from "../db/quote-identifier.ts";

/**
 * A top-K BM25 query against a `lakebase_bm25` index (the `lakebase_text`
 * extension), as statement text plus bind parameters. Nothing here runs a
 * query; the caller executes it with whatever client it holds.
 *
 * The index covers a stored `tsvector` column, so the text-search
 * configuration that built the column must also parse the query: pass the same
 * `config`. Scores from `<@>` are negative and lower is better; a row that
 * shares no term with the query scores 0 and is left out, so a result shorter
 * than `limit` means that few rows matched.
 *
 * `where` is TRUSTED SQL over the table alias `d` (a scope the caller built
 * from its own constants and bind-free predicates). It is spliced in as
 * written and must never carry request text.
 */
export interface Bm25QueryInput {
  /** Table holding the documents; `schema.table` is accepted. */
  table: string;
  /** Column returned as each hit's `key`. */
  keyColumn: string;
  /** The stored tsvector column the index covers. */
  tsvColumn: string;
  /** Name of the `lakebase_bm25` index on `tsvColumn`. */
  index: string;
  /** Text-search configuration, for example `english`. */
  config: string;
  /** The user's query text. Bound, never spliced. */
  query: string;
  limit: number;
  where?: string;
}

export interface Bm25Query {
  text: string;
  params: [config: string, query: string, index: string, limit: number];
}

export function bm25Query(input: Bm25QueryInput): Bm25Query {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error(`bm25Query: limit must be a positive integer, got ${input.limit}`);
  }
  const table = input.table.split(".").map(quoteIdentifier).join(".");
  const key = quoteIdentifier(input.keyColumn);
  const tsv = quoteIdentifier(input.tsvColumn);
  const scope = input.where ? `where ${input.where}` : "";
  const text = `select key, score from (
  select d.${key} as key,
         d.${tsv} <@> to_bm25query(to_tsvector($1::regconfig, $2), $3) as score
  from ${table} d
  ${scope}
) s
where score < 0
order by score, key
limit $4`;
  return { text, params: [input.config, input.query, input.index, input.limit] };
}
