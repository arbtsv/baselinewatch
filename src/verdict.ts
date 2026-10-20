// The pure verdict function: a measurement and its baseline give a ratio and an ok/slow verdict.

export type BaselineEntry = { reference_ms: number; maxRatio: number };
export type Verdict = 'ok' | 'slow';
export type Judgement = { ratio: number; verdict: Verdict };

export function judge(ms: number, baseline: BaselineEntry): Judgement {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError('ms must be a finite number >= 0');
  }
  if (!Number.isFinite(baseline.reference_ms) || !(baseline.reference_ms > 0)) {
    throw new RangeError('reference_ms must be a finite number > 0');
  }
  if (!Number.isFinite(baseline.maxRatio) || !(baseline.maxRatio >= 1)) {
    throw new RangeError('maxRatio must be a finite number >= 1');
  }
  const ratio = ms / baseline.reference_ms;
  // Strictly greater: a ratio exactly at the limit is still ok.
  const verdict: Verdict = ratio > baseline.maxRatio ? 'slow' : 'ok';
  return { ratio, verdict };
}
