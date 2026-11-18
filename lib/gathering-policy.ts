/** Pure lifecycle rules, shared by the scheduler and regression tests. */
export const GATHERING_MAX_TRIALS = 3;
export const GATHERING_POLL_MS = 5_000;
export const GATHERING_CHANCE = 0.35;
export function nextGatheringOpportunity(now: number, random = Math.random): number {
    return now + Math.round((120 + random() * 240) * 1000);
}
export function shouldAttemptGatheringContact(trials: number, random = Math.random): boolean {
    return trials < GATHERING_MAX_TRIALS && random() < GATHERING_CHANCE;
}
export function missedGatheringTick(lastTick: number, now: number): boolean {
    return now - lastTick > GATHERING_POLL_MS * 3;
}
export function gatheringStoryLength(text: string): number {
    return (text.match(/\p{Script=Han}/gu) ?? []).length;
}
