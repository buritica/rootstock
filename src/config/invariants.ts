import type { Invariant, RootstockConfig } from "./define.ts";

const q = (x: unknown): string => JSON.stringify(x);

/**
 * Holds when width `widthName`'s max is strictly below profile
 * `profileName`'s pool max, so a fully busy width still leaves a connection
 * free. A "driver-default" pool max cannot be compared, so it fails.
 */
export function widthBelowPool(widthName: string, profileName: string): Invariant {
  return Object.freeze({
    id: `width-below-pool.${widthName.toLowerCase()}.${profileName.toLowerCase()}`,
    check(config: RootstockConfig): string | null {
      const { widths } = config.concurrency;
      const { profiles } = config.client;
      const w = Object.hasOwn(widths, widthName) ? widths[widthName] : undefined;
      if (w === undefined) return `no width ${q(widthName)} is declared`;
      const p = Object.hasOwn(profiles, profileName) ? profiles[profileName] : undefined;
      if (p === undefined) return `no profile ${q(profileName)} is declared`;
      const pm = p.max;
      if (pm === "driver-default") {
        return `width ${q(widthName)} cannot be checked against profile ${q(profileName)}: its max is "driver-default"`;
      }
      if (w.max < pm) return null;
      return `width ${q(widthName)} max ${w.max} must be below profile ${q(profileName)} max ${pm}`;
    },
  });
}
