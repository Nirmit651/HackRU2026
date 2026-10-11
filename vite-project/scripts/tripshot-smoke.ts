import { tripshotLive } from "../server/tripshot";
try {
  const live = await tripshotLive();
  if (live.stale || !live.vehicles.length) throw new Error("TripShot returned no fresh vehicle positions");
  console.log(JSON.stringify({ ok: true, vehicles: live.vehicles.length, collegeAveStops: live.targetStops.map((s) => ({ id: s.id, name: s.name })), nextArrival: live.nextArrival, vehicleFeedAt: live.vehicleFeedAt, tripFeedAt: live.tripFeedAt }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, upstreamUnavailable: true, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
