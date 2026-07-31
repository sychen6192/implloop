// Stuck detection: a repeated failure signature means the loop is adding no information.
// Signature = gate + normalized error text, so "same failure, different timestamp" still
// counts as a repeat. Only LONG digit runs (>=4: timestamps, addresses, ids, durations)
// are stripped — short numbers stay, because `expected 5 but was 3` and `expected 7 but
// was 2` are DIFFERENT failures and collapsing them stops the loop prematurely on exactly
// the assertion-failure class where models need the most attempts.
import { createHash } from "node:crypto";

export function failureSignature(gate: string, report: string): string {
  const normalized = report
    .toLowerCase()
    .replace(/\d+(\.\d+)?\s*(ms|s|secs?|seconds?)\b/g, "#dur") // durations
    .replace(/\d{4,}/g, "#") // timestamps, addresses, ids
    .replace(/[a-z]?:?[\\/][^\s:,)]+/g, "<path>") // absolute/relative paths
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return createHash("sha1").update(`${gate}\n${normalized}`).digest("hex");
}

// Tracks consecutive repeats of the same signature.
export class StuckDetector {
  private last = "";
  private repeats = 0;

  constructor(private readonly limit: number) {}

  // Record a failure; returns true when the run should stop (limit consecutive repeats).
  record(gate: string, report: string): boolean {
    const sig = failureSignature(gate, report);
    if (sig === this.last) {
      this.repeats += 1;
    } else {
      this.last = sig;
      this.repeats = 0;
    }
    return this.repeats >= this.limit;
  }
}
