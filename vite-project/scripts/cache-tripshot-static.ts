import { refreshTripshotStaticCache } from "../server/tripshot";

const result = await refreshTripshotStaticCache();
console.log(`Cached TripShot static GTFS: ${result.routes} routes, ${result.stops} stops, ${result.trips} trips, ${result.shapes} shapes.`);
