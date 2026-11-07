declare const turnQueueBrand: unique symbol;
/** One per process, made by the consumer and passed to every waiting acquire. */
export interface TurnQueue {
  readonly [turnQueueBrand]: true;
}

/** Each queue's chains: per lock name, the link the next arrival waits on. */
const tails = new WeakMap<object, Map<string, Promise<void>>>();

export function createTurnQueue(): TurnQueue {
  const queue = Object.freeze({});
  tails.set(queue, new Map());
  return queue as TurnQueue;
}

export function isTurnQueue(value: unknown): value is TurnQueue {
  return typeof value === "object" && value !== null && tails.has(value);
}

export interface Turn {
  /** The predecessor's link, or undefined when the chain was empty. Never rejects. */
  readonly ahead: Promise<void> | undefined;
  /** Ends this caller's part: its link resolves once `ahead` has too. Run-once. */
  readonly done: () => void;
}

/**
 * Appends a caller to `name`'s chain. Its link resolves only after its
 * predecessor's and its own `done`, so a caller that gives up early still
 * holds its place until the one ahead of it finishes.
 */
export function enqueueTurn(turns: TurnQueue, name: string): Turn {
  const chains = tails.get(turns) as Map<string, Promise<void>>;
  const ahead = chains.get(name);
  let finish: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const link = ahead === undefined ? mine : ahead.then(() => mine);
  chains.set(name, link);
  void link.then(() => {
    if (chains.get(name) === link) chains.delete(name);
  });
  let finished = false;
  return {
    ahead,
    done: () => {
      if (finished) return;
      finished = true;
      finish();
    },
  };
}
