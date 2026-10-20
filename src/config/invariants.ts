import type { Invariant, RootstockConfig } from "./define.ts";

const q = (x: unknown): string => JSON.stringify(x);

/** An own entry only, so a name like "toString" is not found on the prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Holds when width `widthName`'s max is strictly below profile
 * `profileName`'s pool max, so a fully busy width still leaves a connection
 * free. A "driver-default" pool max cannot be compared, so it fails.
 */
export function widthBelowPool(widthName: string, profileName: string): Invariant {
  // Lowercased, so widths "fooBar" and "foobar" against one profile share an
  // id and the second is refused as a duplicate.
  return Object.freeze({
    id: `width-below-pool.${widthName.toLowerCase()}.${profileName.toLowerCase()}`,
    check(config: RootstockConfig): string | null {
      const w = own(config.concurrency.widths, widthName);
      if (w === undefined) return `no width ${q(widthName)} is declared`;
      const p = own(config.client.profiles, profileName);
      if (p === undefined) return `no profile ${q(profileName)} is declared`;
      if (p.max === "driver-default") {
        return `width ${q(widthName)} cannot be checked against profile ${q(profileName)}: its max is "driver-default"`;
      }
      if (w.max < p.max) return null;
      return `width ${q(widthName)} max ${w.max} must be below profile ${q(profileName)} max ${p.max}`;
    },
  });
}
