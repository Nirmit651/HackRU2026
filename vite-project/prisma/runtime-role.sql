-- Run using migration-owner credentials after setting a strong login password
-- out of band. The role is server-only, never a Supabase browser role.
CREATE ROLE scarlet_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO scarlet_runtime;
GRANT SELECT,INSERT ON profiles,environments,wallets,markets,positions,trades,transfers,market_events,outbox_deliveries,evidence,settlements,payouts,demo_actions,chain_commitments TO scarlet_runtime;
GRANT UPDATE ON profiles,environments,wallets,markets,positions,outbox_deliveries,chain_commitments TO scarlet_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['profiles','environments','wallets','markets','positions','trades','transfers','market_events','outbox_deliveries','evidence','settlements','payouts','demo_actions','chain_commitments'] LOOP EXECUTE format('CREATE POLICY server_role ON %I TO scarlet_runtime USING (true) WITH CHECK (true)',t);END LOOP;END $$;
-- Grants permit server business services. End-user ownership is checked by API.
-- No grants on auth, storage or realtime schemas; no DELETE or audit UPDATE.
GRANT SELECT,INSERT,UPDATE ON automation_configs,automation_jobs,automation_states,weather_observations TO scarlet_runtime;
GRANT SELECT,INSERT,UPDATE ON presentation_demo_runs,simulation_bot_states,simulation_decisions TO scarlet_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['automation_configs','automation_jobs','automation_states','weather_observations'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='server_role') THEN EXECUTE format('CREATE POLICY server_role ON %I TO scarlet_runtime USING(true) WITH CHECK(true)',t); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['presentation_demo_runs','simulation_bot_states','simulation_decisions'] LOOP
 IF to_regclass('public.'||t) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='server_role') THEN
   EXECUTE format('CREATE POLICY server_role ON %I TO scarlet_runtime USING(true) WITH CHECK(true)',t);
 END IF;
 END LOOP;
 IF to_regclass('public.bus_observations') IS NOT NULL THEN
 GRANT SELECT ON public.bus_observations TO scarlet_runtime;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='bus_observations' AND policyname='automation_read') THEN CREATE POLICY automation_read ON public.bus_observations FOR SELECT TO scarlet_runtime USING(true); END IF;
 END IF; END $$;
