/**
 * Temporal decay for search result scoring.
 *
 * Applies exponential decay based on document age so that recently
 * modified/indexed content ranks higher than stale content.
 *
 * Decay follows: score × e^(−λ × ageInDays), where λ = ln(2) / halfLifeDays.
 * At exactly `halfLifeDays`, a result's score is halved.
 */

export interface TemporalDecayConfig {
  /** Enable/disable temporal decay. Default: false (opt-in). */
  enabled: boolean;
  /** Number of days after which a result's score is halved. Default: 30. */
  halfLifeDays: number;
}

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the exponential decay constant λ from a half-life in days.
 *
 * λ = ln(2) / halfLifeDays   →   e^(−λ × halfLifeDays) = 0.5
 */
export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;
}

/**
 * Calculate the decay multiplier for a given age.
 * Returns a value in (0, 1] — 1 for brand-new results, 0.5 at halfLifeDays.
 */
export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  const clampedAge = Math.max(0, params.ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) {
    return 1;
  }
  return Math.exp(-lambda * clampedAge);
}

/**
 * Apply temporal decay to a single score.
 */
export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

/**
 * Compute age in days from an ISO timestamp string to a reference time.
 */
export function ageInDaysFromTimestamp(
  isoTimestamp: string,
  nowMs: number,
): number {
  const ts = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ts)) {
    return 0; // Unknown age → no decay
  }
  return Math.max(0, nowMs - ts) / DAY_MS;
}

/**
 * Search result with an `indexedAt` ISO timestamp for decay computation.
 */
export interface DecayableResult {
  score: number;
  indexedAt?: string;
}

/**
 * Apply temporal decay to an array of search results.
 * Results without `indexedAt` are left unchanged (no penalty).
 */
export function applyTemporalDecay<T extends DecayableResult>(
  results: T[],
  config: Partial<TemporalDecayConfig> = {},
  nowMs?: number,
): T[] {
  const merged = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...config };
  if (!merged.enabled) {
    return results;
  }
  const now = nowMs ?? Date.now();
  return results.map((entry) => {
    if (!entry.indexedAt) {
      return entry;
    }
    const age = ageInDaysFromTimestamp(entry.indexedAt, now);
    return {
      ...entry,
      score: applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: age,
        halfLifeDays: merged.halfLifeDays,
      }),
    };
  });
}
