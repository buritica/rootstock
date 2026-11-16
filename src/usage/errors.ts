import { codeIn } from "../internal/slice.ts";

const CODES = ["ERR_ROOTSTOCK_USAGE_CONFIG"] as const;
export type UsageErrorCode = (typeof CODES)[number];
const CODE_SET: ReadonlySet<UsageErrorCode> = new Set(CODES);

/** A usage refusal. Branch on `code`, never on the text. */
export class RootstockUsageError extends Error {
  override readonly name = "RootstockUsageError";
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, detail: string) {
    super(`rootstock usage: ${detail}`);
    this.code = code;
  }
}

/** The code of a usage refusal, by `code` (survives two module copies), or undefined. */
export function usageErrorCode(err: unknown): UsageErrorCode | undefined {
  return codeIn(CODE_SET, err);
}

export const configError = (detail: string): RootstockUsageError =>
  new RootstockUsageError("ERR_ROOTSTOCK_USAGE_CONFIG", detail);
