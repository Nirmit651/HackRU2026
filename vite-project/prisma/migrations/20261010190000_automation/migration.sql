ALTER TABLE markets ADD COLUMN "generatorKey" text, ADD COLUMN "templateVersion" integer;
ALTER TABLE markets ADD CONSTRAINT automation_identity_complete CHECK (
 ("generatorKey" IS NULL AND "templateVersion" IS NULL) OR
 ("generatorKey" IS NOT NULL AND "templateVersion" IS NOT NULL AND "templateVersion">0 AND jsonb_typeof("resolutionRule"->'automation')='object'));
CREATE UNIQUE INDEX "markets_environmentId_generatorKey_key" ON markets("environmentId","generatorKey");
CREATE TABLE automation_configs (
 id uuid PRIMARY KEY, "environmentId" uuid NOT NULL REFERENCES environments(id), type text NOT NULL CHECK(type IN ('temperature','football','basketball','bus')),
 enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, settings jsonb NOT NULL,
 "nextRunAt" timestamptz NOT NULL DEFAULT now(), "lastRunAt" timestamptz, summary jsonb NOT NULL DEFAULT '{}',
 UNIQUE("environmentId",type));
CREATE TABLE automation_jobs (
 id uuid PRIMARY KEY, "environmentId" uuid NOT NULL REFERENCES environments(id), key text NOT NULL, kind text NOT NULL CHECK(kind IN ('GENERATE','MONITOR','REVIEW')),
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','FAILED')),
 "runAt" timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), "leaseToken" uuid, "leaseUntil" timestamptz,
 "lastError" text, "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("environmentId",key));
CREATE INDEX "automation_jobs_status_runAt_idx" ON automation_jobs(status,"runAt");
CREATE TABLE automation_states (
 id uuid PRIMARY KEY, "environmentId" uuid NOT NULL REFERENCES environments(id), key text NOT NULL, kind text NOT NULL, "marketId" uuid UNIQUE,
 version integer NOT NULL DEFAULT 0, data jsonb NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("environmentId",key), FOREIGN KEY("marketId","environmentId") REFERENCES markets(id,"environmentId"));
CREATE INDEX "automation_states_environmentId_kind_idx" ON automation_states("environmentId",kind);
CREATE TABLE weather_observations (
 id uuid PRIMARY KEY, "environmentId" uuid NOT NULL REFERENCES environments(id), station text NOT NULL, "sourceId" text NOT NULL,
 "observedAt" timestamptz NOT NULL, "fetchedAt" timestamptz NOT NULL DEFAULT now(), "temperatureF" double precision NOT NULL, quality text NOT NULL,
 UNIQUE("environmentId",station,"sourceId"));
CREATE INDEX "weather_observations_environmentId_station_observedAt_idx" ON weather_observations("environmentId",station,"observedAt");
CREATE FUNCTION protect_automation_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW."generatorKey",NEW."templateVersion") IS DISTINCT FROM (OLD."generatorKey",OLD."templateVersion") THEN RAISE EXCEPTION 'immutable automation identity'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER automation_identity BEFORE UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION protect_automation_identity();
REVOKE EXECUTE ON FUNCTION protect_automation_identity() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['automation_configs','automation_jobs','automation_states','weather_observations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated',t); END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='scarlet_runtime') THEN
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO scarlet_runtime',t);
  EXECUTE format('CREATE POLICY server_role ON %I TO scarlet_runtime USING(true) WITH CHECK(true)',t);
 END IF;
 END LOOP;
 IF to_regclass('public.bus_observations') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='scarlet_runtime') THEN
  GRANT SELECT ON public.bus_observations TO scarlet_runtime;
  CREATE POLICY automation_read ON public.bus_observations FOR SELECT TO scarlet_runtime USING(true);
 END IF;
 END $$;
