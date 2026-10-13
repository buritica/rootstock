/**
 * Budget primitives: a greedy packer, a code-unit line slicer, a char-budget
 * formula, and a paragraph-first body splitter built on the first two. Every
 * length is in UTF-16 code units, and every policy value is a parameter.
 */

export interface PackOptions<T> {
  /** Char ceiling for one group, separators included. */
  readonly budget: number;
  /** How many chars one item occupies. */
  readonly sizeOf: (item: T) => number;
  /** Chars charged for the join between two items. */
  readonly separatorCost: number;
  /** Also charge `separatorCost` for the first item of a group. Defaults to false. */
  readonly separatorChargedOnFirst?: boolean;
}

/**
 * Greedily packs `items` into groups that each fit `budget`, in order, never
 * reordering or dropping an item. An item larger than the budget on its own
 * gets a group of its own. An item's cost is measured against the group as it
 * stands, then measured again in the group it lands in, so with the default
 * convention an item that starts a new group pays no separator. Throws when
 * `budget` is below 1 or NaN.
 */
export function packWithinBudget<T>(items: readonly T[], options: PackOptions<T>): T[][] {
  const { budget, sizeOf, separatorCost, separatorChargedOnFirst = false } = options;
  if (!(budget >= 1)) {
    throw new Error(`packWithinBudget: budget must be at least 1 char, got ${budget}`);
  }
  const groups: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  const costInCurrentGroup = (item: T): number =>
    current.length === 0 && !separatorChargedOnFirst ? sizeOf(item) : sizeOf(item) + separatorCost;
  for (const item of items) {
    if (current.length > 0 && chars + costInCurrentGroup(item) > budget) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    chars += costInCurrentGroup(item);
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Returns every line at most `width` code units long, slicing longer ones into
 * consecutive `width`-sized pieces. A cut may split a surrogate pair. Throws
 * when `width` is below 1 or NaN.
 */
export function sliceLongLines(lines: readonly string[], width: number): string[] {
  if (!(width >= 1)) {
    throw new Error(`sliceLongLines: width must be at least 1 char, got ${width}`);
  }
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    for (let at = 0; at < line.length; at += width) {
      out.push(line.slice(at, at + width));
    }
  }
  return out;
}

export interface CharBudgetParams {
  /** The window, in tokens. */
  readonly maxInputTokens: number;
  /** Tokens left unused under the window. */
  readonly tokenMargin: number;
  /** Chars of separator joined around the body. */
  readonly joinChars: number;
  /** Chars reserved for a label the caller appends to the title. */
  readonly labelReserveChars: number;
}

/**
 * The chars one part's body may occupy:
 * `Math.floor((maxInputTokens - tokenMargin) * charsPerToken - (title.length + labelReserveChars + joinChars))`.
 * The result can be negative, and NaN inputs pass through as NaN.
 */
export function partCharBudget(
  title: string,
  charsPerToken: number,
  params: CharBudgetParams,
): number {
  return Math.floor(
    (params.maxInputTokens - params.tokenMargin) * charsPerToken -
      (title.length + params.labelReserveChars + params.joinChars),
  );
}

const PARAGRAPH_SEP = "\n\n";

/**
 * Splits `body` into parts that each fit `options.charBudget`: paragraphs
 * (split on runs of two or more `\n`) are packed first, a paragraph larger
 * than the budget is split at `\n` boundaries, and a line larger than the
 * budget is sliced. Parts join their paragraphs with exactly one blank line.
 * `title` and `options.adapter` appear only in the refusal messages. Throws
 * when `charBudget` is below 1 or NaN.
 */
export function splitBodyWithinBudget(
  title: string,
  body: string,
  options: { readonly charBudget: number; readonly adapter: string },
): string[] {
  const { charBudget, adapter } = options;
  if (!(charBudget >= 1)) {
    throw new Error(
      `${adapter}: char budget for title ${JSON.stringify(title)} is ${charBudget} — the title alone exceeds the embedding window`,
    );
  }

  const blocks: string[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
    if (paragraph.length <= charBudget) {
      blocks.push(paragraph);
      continue;
    }
    blocks.push(...hardSplitParagraph(paragraph, charBudget));
  }

  const parts = packWithinBudget(blocks, {
    budget: charBudget,
    sizeOf: (block) => block.length,
    separatorCost: PARAGRAPH_SEP.length,
  }).map((group) => group.join(PARAGRAPH_SEP));
  if (parts.length === 0) {
    throw new Error(
      `${adapter}: splitter produced zero parts for title ${JSON.stringify(title)} — the packer dropped every block, which must never happen`,
    );
  }
  return parts;
}

/** One oversize paragraph as line-bounded blocks that each fit, slicing any line past the budget. */
function hardSplitParagraph(paragraph: string, charBudget: number): string[] {
  return packWithinBudget(sliceLongLines(paragraph.split("\n"), charBudget), {
    budget: charBudget,
    sizeOf: (line) => line.length,
    separatorCost: 1,
  }).map((group) => group.join("\n"));
}
