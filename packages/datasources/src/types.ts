import type { Coverage, Evidence } from "@cr/shared";

/** Every adapter returns evidence (possibly empty) plus a coverage line, never throws to the engine. */
export interface AdapterResult {
  evidence: Evidence[];
  coverage: Coverage;
  /** raw facts the engine may want (e.g. frozen: true) */
  facts?: Record<string, unknown>;
}

export const now = () => new Date().toISOString();

export function unavailable(source: string, err: unknown): AdapterResult {
  return {
    evidence: [],
    coverage: { source, status: "unavailable", detail: err instanceof Error ? err.message : String(err) },
  };
}
