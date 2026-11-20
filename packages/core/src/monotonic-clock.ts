export function clock(
  wallTime = Date.now,
  monotonic = () => performance.now(),
) {
  let previousWall = wallTime(),
    anchorMono = monotonic(),
    anchorTime = previousWall,
    latest = previousWall;
  return () => {
    const wall = wallTime(),
      mono = monotonic();
    // 大幅回拨时将逻辑时间推进超过 24 小时，使已有租约过期。
    if (wall < previousWall - 5000) {
      anchorTime = latest + 86400001;
      anchorMono = mono;
    }
    latest = Math.max(latest, wall, anchorTime + mono - anchorMono);
    previousWall = wall;
    return Math.floor(latest);
  };
}
