import { readFile } from "node:fs/promises";
import { cacheTripshotStaticGtfs } from "../server/tripshot";

const archivePath = process.argv[2];
if (!archivePath) throw new Error("TRIPSHOT_ARCHIVE_PATH_REQUIRED");
const value = await cacheTripshotStaticGtfs(await readFile(archivePath));
console.log(`Cached TripShot static GTFS: ${value.routes.size} routes, ${value.stops.length} stops, ${value.trips.size} trips, ${value.shapes.size} shapes.`);
