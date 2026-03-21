/**
 * Maximal Marginal Relevance (MMR) re-ranking algorithm.
 *
 * MMR balances relevance with diversity by iteratively selecting results
 * that maximize:  λ × relevance − (1−λ) × max_similarity_to_selected
 *
 * Uses Jaccard similarity over lowercased alphanumeric tokens.
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 * @see OpenClaw reference: openclaw/src/memory/mmr.ts
 */

export interface MMRConfig {
  /** Enable/disable MMR re-ranking. Default: false (opt-in). */
  enabled: boolean;
  /** Lambda parameter: 0 = max diversity, 1 = max relevance. Default: 0.7. */
  lambda: number;
}

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

/** Internal item shape for the generic MMR algorithm. */
interface MMRItem {
  id: string;
  score: number;
  content: string;
}

/**
 * Tokenize text for Jaccard similarity computation.
 * Extracts alphanumeric/underscore tokens, normalized to lowercase.
 */
export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens);
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
export function jaccardSimilarity(
  setA: Set<string>,
  setB: Set<string>,
): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize++;
    }
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Compute MMR score for a candidate item.
 * MMR = λ × relevance − (1−λ) × max_similarity_to_selected
 */
function computeMMRScore(
  relevance: number,
  maxSimilarity: number,
  lambda: number,
): number {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

const MMR_MAX_CANDIDATES = 200;

/**
 * Re-rank items using Maximal Marginal Relevance (MMR).
 *
 * 1. Start with the highest-scoring item.
 * 2. For each remaining slot, pick the item maximizing the MMR score.
 * 3. Repeat until all items are placed.
 *
 * Uses incremental max-similarity tracking to reduce redundant comparisons.
 * Input is capped at MMR_MAX_CANDIDATES to keep O(n²) tractable.
 */
function mmrRerank<T extends MMRItem>(
  items: T[],
  config: Partial<MMRConfig> = {},
): T[] {
  const {
    enabled = DEFAULT_MMR_CONFIG.enabled,
    lambda = DEFAULT_MMR_CONFIG.lambda,
  } = config;

  if (!enabled || items.length <= 1) {
    return [...items];
  }

  const clampedLambda = Math.max(0, Math.min(1, lambda));

  // λ = 1 → pure relevance ranking, skip the similarity work
  if (clampedLambda === 1) {
    return [...items].sort((a, b) => b.score - a.score);
  }

  // Guard: cap candidates to keep O(n²) tractable
  const candidates =
    items.length > MMR_MAX_CANDIDATES
      ? [...items]
          .sort((a, b) => b.score - a.score)
          .slice(0, MMR_MAX_CANDIDATES)
      : items;

  // Pre-tokenize for efficiency
  const tokenCache = new Map<string, Set<string>>();
  for (const item of candidates) {
    tokenCache.set(item.id, tokenize(item.content));
  }

  // Normalize scores to [0, 1] for fair comparison with similarity
  // Use iterative reduce to avoid stack overflow with spread on large arrays
  let maxScore = -Infinity;
  let minScore = Infinity;
  for (const item of candidates) {
    if (item.score > maxScore) maxScore = item.score;
    if (item.score < minScore) minScore = item.score;
  }
  const scoreRange = maxScore - minScore;
  const normalizeScore = (score: number): number =>
    scoreRange === 0 ? 1 : (score - minScore) / scoreRange;

  const selected: T[] = [];
  const remaining = new Set(candidates);

  // Track max similarity to any selected item per candidate (incremental)
  const maxSimToSelected = new Map<string, number>(
    candidates.map((item) => [item.id, 0]),
  );

  while (remaining.size > 0) {
    let bestItem: T | null = null;
    let bestMMRScore = -Infinity;

    for (const candidate of remaining) {
      const mmrScore = computeMMRScore(
        normalizeScore(candidate.score),
        maxSimToSelected.get(candidate.id) ?? 0,
        clampedLambda,
      );

      if (
        mmrScore > bestMMRScore ||
        (mmrScore === bestMMRScore &&
          candidate.score > (bestItem?.score ?? -Infinity))
      ) {
        bestMMRScore = mmrScore;
        bestItem = candidate;
      }
    }

    if (!bestItem) {
      break; // safety exit
    }

    selected.push(bestItem);
    remaining.delete(bestItem);

    // Incrementally update max similarities (avoids full re-scan)
    const bestTokens =
      tokenCache.get(bestItem.id) ?? tokenize(bestItem.content);
    for (const candidate of remaining) {
      const candidateTokens =
        tokenCache.get(candidate.id) ?? tokenize(candidate.content);
      const sim = jaccardSimilarity(candidateTokens, bestTokens);
      const current = maxSimToSelected.get(candidate.id) ?? 0;
      if (sim > current) {
        maxSimToSelected.set(candidate.id, sim);
      }
    }
  }

  return selected;
}

/**
 * A hybrid search result that carries a text snippet for MMR comparison.
 */
export interface MMRableResult {
  score: number;
  snippet: string;
  filePath: string;
  startLine: number;
}

/**
 * Apply MMR re-ranking to hybrid search results.
 * Adapts the generic MMR algorithm to the hybrid result shape.
 */
export function applyMMR<T extends MMRableResult>(
  results: T[],
  config: Partial<MMRConfig> = {},
): T[] {
  if (results.length === 0) {
    return results;
  }

  const itemById = new Map<string, T>();
  const mmrItems: MMRItem[] = results.map((r, index) => {
    const id = `${r.filePath}:${r.startLine}:${index}`;
    itemById.set(id, r);
    return { id, score: r.score, content: r.snippet };
  });

  const reranked = mmrRerank(mmrItems, config);
  return reranked.map((item) => itemById.get(item.id)!);
}
