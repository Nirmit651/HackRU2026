-- Application-owned tables only. Prisma is the sole migration owner.
ALTER TABLE profiles ADD CONSTRAINT human_identity CHECK ((kind='HUMAN' AND "authUserId" IS NOT NULL) OR (kind='BOT' AND "authUserId" IS NULL));
ALTER TABLE environments ADD CONSTRAINT environment_bounds CHECK ("initialSupplyMicros">0 AND "startingGrantMicros">0 AND speed BETWEEN 1 AND 10 AND "runState" IN ('PAUSED','RUNNING') AND (kind='LIVE' OR ("virtualNow" IS NOT NULL AND "simulatedStartAt" IS NOT NULL)));
ALTER TABLE wallets ADD CONSTRAINT wallet_bounds CHECK ("balanceMicros">=0 AND "openingBalanceMicros">=0 AND ((kind='USER')=("profileId" IS NOT NULL)) AND (kind='TREASURY' OR "openingBalanceMicros"=0));
CREATE UNIQUE INDEX one_treasury ON wallets("environmentId") WHERE kind='TREASURY';
CREATE UNIQUE INDEX one_grant ON transfers("toWalletId") WHERE kind='STARTING_GRANT';
ALTER TABLE markets ADD CONSTRAINT market_bounds CHECK ("liquidityBMicros">=1000000 AND "yesShares">=0 AND "noShares">=0 AND "yesShares"+"noShares"<=1000001000 AND "yesPrice" BETWEEN 0 AND 1 AND "volumeMicros">=0 AND version>=0 AND "closesAt">"opensAt");
ALTER TABLE positions ADD CONSTRAINT position_bounds CHECK ("yesShares">=0 AND "noShares">=0 AND "totalCostMicros">=0);
ALTER TABLE trades ADD CONSTRAINT trade_bounds CHECK (quantity BETWEEN 1 AND 1000 AND "costMicros">0 AND "yesPriceBefore" BETWEEN 0 AND 1 AND "yesPriceAfter" BETWEEN 0 AND 1);
ALTER TABLE transfers ADD CONSTRAINT transfer_bounds CHECK ("amountMicros">0 AND "fromWalletId"<>"toWalletId");
ALTER TABLE payouts ADD CONSTRAINT payout_bounds CHECK ("amountMicros">=0 AND "originalCostMicros">=0 AND (("amountMicros"=0)=("transferId" IS NULL)));
ALTER TABLE market_events ADD CONSTRAINT event_bounds CHECK (version>0 AND "tradeAmountMicros">=0 AND "yesPrice" BETWEEN 0 AND 1 AND ((kind='PRICE_CHANGED')=("tradeId" IS NOT NULL)) AND (kind='PRICE_CHANGED' OR "tradeAmountMicros"=0));
ALTER TABLE demo_actions ADD FOREIGN KEY ("environmentId") REFERENCES environments(id);
ALTER TABLE demo_actions ADD FOREIGN KEY ("actorProfileId") REFERENCES profiles(id);
ALTER TABLE chain_commitments ADD FOREIGN KEY ("marketId","environmentId") REFERENCES markets(id,"environmentId");
ALTER TABLE chain_commitments ADD FOREIGN KEY ("settlementId","environmentId","marketId") REFERENCES settlements(id,"environmentId","marketId");
ALTER TABLE evidence ADD FOREIGN KEY ("submittedByProfileId") REFERENCES profiles(id);
ALTER TABLE settlements ADD FOREIGN KEY ("resolvedByProfileId") REFERENCES profiles(id);
ALTER TABLE market_events ADD FOREIGN KEY ("tradeId") REFERENCES trades(id);
CREATE FUNCTION protect_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'immutable audit row'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['trades','transfers','market_events','evidence','settlements','payouts','demo_actions'] LOOP EXECUTE format('CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_audit()',t); END LOOP; END $$;
CREATE FUNCTION protect_market() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status<>'DRAFT' AND (NEW."resolutionRule",NEW."ruleHash",NEW."ruleVersion",NEW."liquidityBMicros",NEW."opensAt",NEW."closesAt",NEW.provider,NEW."externalEventId",NEW."sourceUrl",NEW.title,NEW."marketMakerWalletId",NEW."environmentId",NEW.category,NEW.context) IS DISTINCT FROM (OLD."resolutionRule",OLD."ruleHash",OLD."ruleVersion",OLD."liquidityBMicros",OLD."opensAt",OLD."closesAt",OLD.provider,OLD."externalEventId",OLD."sourceUrl",OLD.title,OLD."marketMakerWalletId",OLD."environmentId",OLD.category,OLD.context) THEN RAISE EXCEPTION 'frozen market rules'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wallets WHERE id=NEW."marketMakerWalletId" AND kind='MARKET_MAKER' AND "environmentId"=NEW."environmentId") THEN RAISE EXCEPTION 'invalid maker wallet'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER market_protection BEFORE INSERT OR UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION protect_market();
CREATE FUNCTION protect_environment() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW.kind,NEW."initialSupplyMicros",NEW."startingGrantMicros",NEW.seed,NEW."scenarioVersion",NEW."simulatedStartAt") IS DISTINCT FROM (OLD.kind,OLD."initialSupplyMicros",OLD."startingGrantMicros",OLD.seed,OLD."scenarioVersion",OLD."simulatedStartAt") THEN RAISE EXCEPTION 'immutable environment'; END IF;RETURN NEW;END $$;
CREATE TRIGGER environment_protection BEFORE UPDATE ON environments FOR EACH ROW EXECUTE FUNCTION protect_environment();
CREATE FUNCTION protect_wallet() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW."openingBalanceMicros",NEW.kind,NEW."environmentId",NEW."profileId") IS DISTINCT FROM (OLD."openingBalanceMicros",OLD.kind,OLD."environmentId",OLD."profileId") THEN RAISE EXCEPTION 'immutable wallet identity'; END IF;RETURN NEW;END $$;
CREATE TRIGGER wallet_protection BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['profiles','environments','wallets','markets','positions','trades','transfers','market_events','outbox_deliveries','evidence','settlements','payouts','demo_actions','chain_commitments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated',t); END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
 GRANT SELECT ON market_events TO anon,authenticated;
 EXECUTE 'CREATE POLICY public_events ON market_events FOR SELECT TO anon,authenticated USING (true)';
 END IF;
 IF EXISTS(SELECT FROM pg_publication WHERE pubname='supabase_realtime') THEN ALTER PUBLICATION supabase_realtime ADD TABLE market_events; END IF;
END $$;
-- All routines use invoker privileges; no browser mutation functions are exposed.
REVOKE EXECUTE ON FUNCTION protect_audit(),protect_market(),protect_environment(),protect_wallet() FROM PUBLIC;
