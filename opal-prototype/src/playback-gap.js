export function remainingGapMilliseconds(endsAt, now = Date.now()) {
  const deadline = Number(endsAt);
  const currentTime = Number(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(currentTime)) return 0;
  return Math.max(0, Math.ceil(deadline - currentTime));
}
