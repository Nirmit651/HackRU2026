CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS market_ticks (
 event_time timestamptz NOT NULL,event_id uuid NOT NULL,environment_id uuid NOT NULL,
 market_id uuid NOT NULL,market_version bigint NOT NULL,event_kind text NOT NULL,
 yes_price numeric NOT NULL,trade_amount_micros bigint NOT NULL,executed_side text,share_quantity bigint,payload jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(event_time,event_id)
);
SELECT create_hypertable('market_ticks',by_range('event_time'),if_not_exists=>true);
CREATE INDEX IF NOT EXISTS market_ticks_history ON market_ticks(environment_id,market_id,event_time DESC);
CREATE MATERIALIZED VIEW IF NOT EXISTS market_minutes WITH (timescaledb.continuous,timescaledb.materialized_only=false) AS
 SELECT time_bucket('1 minute',event_time) AS bucket,environment_id,market_id,
 first(yes_price,market_version) AS open,max(yes_price) AS high,min(yes_price) AS low,last(yes_price,market_version) AS close,
 count(*) FILTER (WHERE event_kind='PRICE_CHANGED') AS trade_count,sum(trade_amount_micros) AS volume_micros
 FROM market_ticks GROUP BY bucket,environment_id,market_id WITH NO DATA;
SELECT add_continuous_aggregate_policy('market_minutes',start_offset=>INTERVAL '30 days',end_offset=>INTERVAL '1 minute',schedule_interval=>INTERVAL '1 minute',if_not_exists=>true);
-- market_version gives deterministic first/last even when timestamps tie.
