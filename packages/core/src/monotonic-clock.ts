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
    // A substantial rollback invalidates every pre-existing 24-hour lease.
    if (wall < previousWall - 5000) {
      anchorTime = latest + 86400001;
      anchorMono = mono;
    }
    latest = Math.max(latest, wall, anchorTime + mono - anchorMono);
    previousWall = wall;
    return Math.floor(latest);
  };
}
