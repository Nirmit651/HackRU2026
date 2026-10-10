-- Run using migration-owner credentials after setting a strong login password
-- out of band. The role is server-only, never a Supabase browser role.
CREATE ROLE scarlet_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO scarlet_runtime;
GRANT SELECT,INSERT ON profiles,environments,wallets,markets,positions,trades,transfers,market_events,outbox_deliveries,evidence,settlements,payouts,demo_actions,chain_commitments TO scarlet_runtime;
GRANT UPDATE ON profiles,environments,wallets,markets,positions,outbox_deliveries,chain_commitments TO scarlet_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['profiles','environments','wallets','markets','positions','trades','transfers','market_events','outbox_deliveries','evidence','settlements','payouts','demo_actions','chain_commitments'] LOOP EXECUTE format('CREATE POLICY server_role ON %I TO scarlet_runtime USING (true) WITH CHECK (true)',t);END LOOP;END $$;
-- Grants permit server business services. End-user ownership is checked by API.
-- No grants on auth, storage or realtime schemas; no DELETE or audit UPDATE.
