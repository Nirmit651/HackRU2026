-- Run daily as migration owner, after a backup. Never removes ledger/receipts.
-- Seven days of transient evidence; unsettled market evidence is always retained.
DELETE FROM weather_observations w WHERE w."observedAt" < clock_timestamp()-interval '7 days'
 AND NOT EXISTS (SELECT 1 FROM markets m WHERE m."environmentId"=w."environmentId"
  AND m.category='TEMPERATURE' AND m."generatorKey" IS NOT NULL AND m.status NOT IN ('RESOLVED','VOIDED')
  AND m."resolutionRule"->'automation'->'settings'->>'station'=w.station);
DELETE FROM automation_states s WHERE s."updatedAt"<clock_timestamp()-interval '7 days'
 AND (s.kind IN ('CACHE','COOLDOWN','BUS_VEHICLE')
 OR (s.kind='BUS_VISIT' AND NOT EXISTS(SELECT 1 FROM markets m WHERE m."environmentId"=s."environmentId" AND m."generatorKey"='bus-dwell:'||substring(s.key from 7) AND m.status NOT IN ('RESOLVED','VOIDED'))));
DELETE FROM automation_states WHERE kind='RUN' AND "updatedAt"<clock_timestamp()-interval '30 days';
-- DONE jobs and proposed receipts are deliberately retained for deduplication.
-- Original bus history retention is owned by the ingestion team.
