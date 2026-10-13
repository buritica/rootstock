/**
 * Section windows: how a body that does not fit one embedding window is cut
 * into several, and where each window's text sits in the original body.
 * Every policy value arrives in `WindowParams`.
 */
import { partCharBudget, splitBodyWithinBudget } from "./budget.ts";

/** UTF-16 offsets `[charStart, charEnd)` of a window in its body, or nulls when it could not be located. */
export type WindowOffsets =
  | { charStart: number; charEnd: number }
  | { charStart: null; charEnd: null };

export interface WindowBodyInput {
  /** Charged against the budget, and named in the refusal message. */
  readonly title: string;
  /** Chars of fixed head (besides the title) that ride every window. */
  readonly headChars: number;
  readonly body: string;
  /** The window, in tokens. */
  readonly maxInputTokens: number;
}

export interface WindowParams {
  readonly charsPerToken: number;
  readonly labelReserveChars: number;
  readonly tokenMargin: number;
  readonly joinChars: number;
  /** A section shorter than this merges into a neighbour. */
  readonly minSectionChars: number;
  /** Growth factor of the trial budget while rebalancing an oversize section. */
  readonly rebalanceStep: number;
  /** The caller name used in the splitter's refusal messages. */
  readonly refusalLabel: string;
}

export type WindowBodyPlan =
  | { kind: "no-room" }
  | { kind: "whole"; charStart: 0; charEnd: number }
  | { kind: "windows"; windows: Array<{ body: string } & WindowOffsets> };

/**
 * Plans the body windows for one text. The body budget is `partCharBudget`
 * over the title less `headChars`. Below 1 the plan is `no-room` (a NaN
 * budget is not below 1 and continues). A body within the budget is `whole`.
 * Otherwise the body is cut before every blank-line-separated block that
 * starts with a Markdown heading (`#` to `######`, a space, then a non-space);
 * sections under `minSectionChars` merge into the previous section when the
 * pair fits, else carry into the next; an oversize section goes through
 * `splitBodyWithinBudget` and is rebalanced to the smallest trial budget that
 * keeps the greedy window count; and each window is located with
 * `locateWindows`.
 */
export function windowBody(input: WindowBodyInput, params: WindowParams): WindowBodyPlan {
  const name = input.title;
  const body = input.body;
  const budget =
    partCharBudget(name, params.charsPerToken, {
      maxInputTokens: input.maxInputTokens,
      labelReserveChars: params.labelReserveChars,
      tokenMargin: params.tokenMargin,
      joinChars: params.joinChars,
    }) - input.headChars;
  if (budget < 1) return { kind: "no-room" };
  if (body.length <= budget) {
    return { kind: "whole", charStart: 0, charEnd: body.length };
  }
  const parts = sectionWindows(name, body, budget, params);
  return {
    kind: "windows",
    windows: locateWindows(body, parts).map((offsets, i) => ({
      body: parts[i] as string,
      ...offsets,
    })),
  };
}

const HEADING_LINE = /^#{1,6} \S/;

function sectionWindows(
  title: string,
  body: string,
  budget: number,
  params: WindowParams,
): string[] {
  const parts: string[] = [];
  for (const section of mergeSmallSections(sectionsOf(body), budget, params)) {
    if (section.length <= budget) parts.push(section);
    else parts.push(...balancedSplit(title, section, budget, params));
  }
  return parts.length > 0 ? parts : [""];
}

function sectionsOf(body: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n\n").trim();
    if (text.length > 0) sections.push(text);
    current = [];
  };
  for (const block of body.split(/\n{2,}/)) {
    if (HEADING_LINE.test(block)) flush();
    current.push(block);
  }
  flush();
  return sections;
}

function mergeSmallSections(sections: string[], budget: number, params: WindowParams): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of sections) {
    const section = carry ? `${carry}\n\n${raw}` : raw;
    carry = "";
    const previous = out.at(-1);
    if (section.length >= params.minSectionChars) {
      out.push(section);
    } else if (previous !== undefined && previous.length + 2 + section.length <= budget) {
      out[out.length - 1] = `${previous}\n\n${section}`;
    } else {
      carry = section;
    }
  }
  if (carry) {
    const previous = out.at(-1);
    if (previous === undefined) out.push(carry);
    else out[out.length - 1] = `${previous}\n\n${carry}`;
  }
  return out;
}

function balancedSplit(
  title: string,
  text: string,
  budget: number,
  params: WindowParams,
): string[] {
  const split = (charBudget: number) =>
    splitBodyWithinBudget(title, text, { charBudget, adapter: params.refusalLabel });
  const greedy = split(budget);
  if (greedy.length <= 1) return greedy;
  for (
    let b = Math.ceil(text.length / greedy.length);
    b < budget;
    b = Math.ceil(b * params.rebalanceStep)
  ) {
    const parts = split(b);
    if (parts.length <= greedy.length) return parts;
  }
  return greedy;
}

const LOCATE_PROBE_CHARS = 64;

/**
 * Locates each window in `body`. A window's first and last non-empty lines
 * (at most 64 code units of each: the head's start, the tail's end) are
 * searched in order from a cursor that never moves backwards, the tail from
 * the earliest offset it can sit at. A window whose probes cannot be found
 * gets null offsets. `body.slice(charStart, charEnd)` equals the window when
 * no blank-line run was collapsed inside it.
 */
export function locateWindows(body: string, parts: readonly string[]): WindowOffsets[] {
  let cursor = 0;
  return parts.map((part) => {
    const lines = part.split("\n").filter((line) => line.length > 0);
    const head = lines[0]?.slice(0, LOCATE_PROBE_CHARS);
    const tail = lines.at(-1)?.slice(-LOCATE_PROBE_CHARS);
    if (!head || !tail) return { charStart: null, charEnd: null };
    const start = body.indexOf(head, cursor);
    if (start < 0) return { charStart: null, charEnd: null };
    const tailAt = body.indexOf(tail, Math.max(start, start + part.length - tail.length));
    if (tailAt < 0) return { charStart: null, charEnd: null };
    cursor = tailAt + tail.length;
    return { charStart: start, charEnd: cursor };
  });
}
