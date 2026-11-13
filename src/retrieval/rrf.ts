/**
 * Reciprocal rank fusion: merges ranked lists whose scores are not comparable
 * (BM25, cosine similarity, trigram similarity) using positions alone.
 *
 * A key's score is the sum over the lists holding it of
 * `weight / (k + rank)`, rank counted from 1. `k` damps the head so one list's
 * first place cannot outvote agreement between lists; 60 is the value from
 * Cormack, Clarke and Buettcher (SIGIR 2009) and the common default.
 *
 * Ties break by the best single rank, then by first appearance, so the result
 * is deterministic for the same input. A key repeated inside one list counts
 * once, at its best rank.
 */
export interface RankedList<T> {
  items: readonly T[];
  /** Relative say of this list. Default 1. */
  weight?: number;
}

export interface RrfOptions<T> {
  /** Identity of an item across lists. */
  key: (item: T) => string;
  /** Head damping. Default 60. */
  k?: number;
  /** Keep only the best `limit` results. */
  limit?: number;
}

export interface Fused<T> {
  /** The item as it appeared in the first list that held it. */
  item: T;
  score: number;
  /** 1-based rank in each input list, by list index; absent lists are omitted. */
  ranks: Record<number, number>;
}

export function reciprocalRankFusion<T>(
  lists: readonly RankedList<T>[],
  options: RrfOptions<T>,
): Fused<T>[] {
  const k = options.k ?? 60;
  if (!(k >= 0)) throw new Error(`reciprocalRankFusion: k must be >= 0, got ${k}`);
  const { limit } = options;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`reciprocalRankFusion: limit must be a non-negative integer, got ${limit}`);
  }
  const byKey = new Map<string, Fused<T> & { order: number; best: number }>();
  lists.forEach((list, listIndex) => {
    const weight = list.weight ?? 1;
    if (!(weight >= 0)) {
      throw new Error(`reciprocalRankFusion: weight must be >= 0, got ${weight}`);
    }
    list.items.forEach((item, i) => {
      const key = options.key(item);
      const rank = i + 1;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { item, score: 0, ranks: {}, order: byKey.size, best: rank };
        byKey.set(key, entry);
      }
      if (entry.ranks[listIndex] !== undefined) return;
      entry.ranks[listIndex] = rank;
      entry.score += weight / (k + rank);
      if (rank < entry.best) entry.best = rank;
    });
  });
  const fused = [...byKey.values()].sort(
    (a, b) => b.score - a.score || a.best - b.best || a.order - b.order,
  );
  const cut = limit === undefined ? fused : fused.slice(0, limit);
  return cut.map(({ item, score, ranks }) => ({ item, score, ranks }));
}
