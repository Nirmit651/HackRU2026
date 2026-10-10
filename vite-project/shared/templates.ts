import { type Rule, ruleSchema, type categories } from "./contracts";
type Category = (typeof categories)[number];
export function marketTemplate(category: Category, environmentId: string) {
  const opensAt = new Date(Date.now() + 300000).toISOString(),
    closesAt = new Date(Date.now() + 3600000).toISOString(),
    windowStart = new Date(Date.now() + 3601000).toISOString(),
    windowEnd = new Date(Date.now() + 7200000).toISOString();
  const yes: Record<Category, string> = {
    TEMPERATURE:
      "The named station observes a temperature of at least 75°F during the specified window.",
    RAINFALL:
      "The named station observes at least 0.10 inches of accumulated precipitation during the window.",
    BUS_ARRIVAL:
      "The identified route and trip reaches the named stop before the observation window ends.",
    CONCERT:
      "The named official organizer announces the specified artist/event by the deadline.",
    STUDENT_ELECTION:
      "The named candidate wins the identified election according to official final results.",
    VARSITY_SPORTS:
      "Rutgers wins the identified scheduled game according to the final provider result.",
  };
  const rule: Rule = ruleSchema.parse({
    canonicalizationVersion: "rutgers-v1",
    yesCondition: yes[category],
    provider: "REPLACE_WITH_PROVIDER",
    externalEventId: "REPLACE_WITH_STATION_EVENT_OR_TRIP_ID",
    windowStart,
    windowEnd,
    cutoff: closesAt,
    units:
      category === "TEMPERATURE"
        ? "F"
        : category === "RAINFALL"
          ? "in"
          : "boolean",
    rounding: "Compare unrounded observations.",
    finality: "FINAL",
    missingPolicy: "PENDING_THEN_VOID",
    voidAfter: new Date(Date.now() + 86400000).toISOString(),
    cancellationPolicy: "VOID",
    tiePolicy: "NO",
    postponementPolicy: "VOID",
    comparison:
      category === "TEMPERATURE" || category === "RAINFALL" ? "GTE" : "TRUE",
    ...(category === "TEMPERATURE"
      ? { threshold: 75 }
      : category === "RAINFALL"
        ? { threshold: 0.1 }
        : {}),
  });
  return {
    environmentId,
    slug: `${category.toLowerCase().replaceAll("_", "-")}-${Date.now()}`,
    title: "REPLACE_WITH_PRECISE_MARKET_QUESTION",
    description:
      "Replace all placeholders and verify identifiers before opening.",
    category,
    opensAt,
    closesAt,
    expectedResolutionAt: windowEnd,
    sourceUrl: "https://example.invalid/replace-with-official-source",
    resolutionRule: rule,
    context:
      category === "VARSITY_SPORTS"
        ? { season: 2026 }
        : category === "BUS_ARRIVAL"
          ? { routeId: "REPLACE", tripId: "REPLACE", stopId: "REPLACE" }
          : {},
    liquidityBMicros: "100000000",
  };
}
