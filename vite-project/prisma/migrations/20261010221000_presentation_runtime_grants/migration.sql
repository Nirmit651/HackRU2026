DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'scarlet_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON presentation_demo_runs, simulation_bot_states, simulation_decisions TO scarlet_runtime;
    CREATE POLICY server_role ON presentation_demo_runs TO scarlet_runtime USING (true) WITH CHECK (true);
    CREATE POLICY server_role ON simulation_bot_states TO scarlet_runtime USING (true) WITH CHECK (true);
    CREATE POLICY server_role ON simulation_decisions TO scarlet_runtime USING (true) WITH CHECK (true);
  END IF;
END $$;
