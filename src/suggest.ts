// A small "did you mean" helper for misspelled configuration keys.

// Edit distance between two strings (insertions, deletions and substitutions each cost 1).
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

// The closest candidate, compared without regard to letter case, when it is near enough to be a
// likely typo: at most 2 edits and at most a third of the candidate's length (rounded up).
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  const wanted = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(wanted, candidate.toLowerCase());
    if (distance <= 2 && distance <= Math.ceil(candidate.length / 3) && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
