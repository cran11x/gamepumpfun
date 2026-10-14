// X SPACES vote tally.
// Count votes per target; players who didn't vote don't count. If the top count is shared (a tie)
// or the top target is 'skip', nobody is ejected.

export const SKIP = 'skip';

export interface TallyResult {
  /** The player to blacklist, or null (tie, skip won, or no votes). */
  ejectedId: string | null;
  /** True when two or more targets share the top count. */
  tie: boolean;
  /** target -> number of votes (only valid targets). */
  counts: Record<string, number>;
}

/**
 * @param votes voterId -> targetId | 'skip'
 * @param isValidTarget votes for targets that fail this check (e.g. a player who left mid-meeting) are ignored.
 */
export function tallyVotes(
  votes: Iterable<readonly [string, string]>,
  isValidTarget: (target: string) => boolean = () => true,
): TallyResult {
  const counts: Record<string, number> = {};
  for (const [, target] of votes) {
    if (target !== SKIP && !isValidTarget(target)) continue;
    counts[target] = (counts[target] ?? 0) + 1;
  }
  let top = 0;
  let leaders: string[] = [];
  for (const [target, n] of Object.entries(counts)) {
    if (n > top) {
      top = n;
      leaders = [target];
    } else if (n === top) {
      leaders.push(target);
    }
  }
  if (top === 0) return { ejectedId: null, tie: false, counts };
  if (leaders.length > 1) return { ejectedId: null, tie: true, counts };
  const winner = leaders[0];
  return { ejectedId: winner === SKIP ? null : winner, tie: false, counts };
}
