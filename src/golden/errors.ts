import type { CapabilityId } from "./capabilities.ts";

/** The message of any thrown value, without ever throwing itself. */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * A golden case threw while its input was hashed (`input`), while it ran
 * (`run`), or while its output was serialized (`output`). The original error
 * is the `cause`.
 */
export class GoldenCaseError extends Error {
  override readonly name = "GoldenCaseError";
  readonly capability: CapabilityId;
  readonly profile: string;
  readonly caseId: string;
  readonly phase: "input" | "run" | "output";

  constructor(
    capability: CapabilityId,
    profile: string,
    caseId: string,
    phase: "input" | "run" | "output",
    options: { cause: unknown },
  ) {
    super(
      `golden case ${capability}/${profile}/${caseId} threw (${phase}): ${messageOf(options.cause)}`,
      options,
    );
    this.capability = capability;
    this.profile = profile;
    this.caseId = caseId;
    this.phase = phase;
  }
}

/** A committed golden file exists but cannot be read as a golden file. */
export class GoldenFileError extends Error {
  override readonly name = "GoldenFileError";
  readonly path: string;

  constructor(path: string, options: { cause: unknown }) {
    super(`golden file ${path} is unreadable: ${messageOf(options.cause)}`, options);
    this.path = path;
  }
}
