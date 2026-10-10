-- Extend the original application migration without touching Supabase-owned schemas.
ALTER TABLE outbox_deliveries ADD CONSTRAINT outbox_state CHECK(status IN ('PENDING','PROCESSING','DELIVERED') AND attempts>=0 AND destination='TIGER');
ALTER TABLE chain_commitments ADD CONSTRAINT chain_state CHECK(kind IN ('RULES','SETTLEMENT') AND network='devnet' AND attempts>=0 AND status IN ('PENDING','SUBMITTED','CONFIRMED') AND ((kind='SETTLEMENT')=("settlementId" IS NOT NULL)));
CREATE FUNCTION protect_commitment() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
 IF (NEW."environmentId",NEW."marketId",NEW.kind,NEW."payloadHash",NEW.network,NEW."signerPublicKey",NEW."canonicalizationVersion") IS DISTINCT FROM (OLD."environmentId",OLD."marketId",OLD.kind,OLD."payloadHash",OLD.network,OLD."signerPublicKey",OLD."canonicalizationVersion") THEN RAISE EXCEPTION 'immutable commitment'; END IF;RETURN NEW;END $$;
CREATE TRIGGER commitment_protection BEFORE UPDATE ON chain_commitments FOR EACH ROW EXECUTE FUNCTION protect_commitment();
CREATE FUNCTION validate_financial_link() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE payment transfers; maker uuid; BEGIN
 SELECT "marketMakerWalletId" INTO maker FROM markets WHERE id=NEW."marketId";
 IF TG_TABLE_NAME='trades' THEN
 SELECT * INTO payment FROM transfers WHERE id=NEW."paymentTransferId";
 IF payment."environmentId"<>NEW."environmentId" OR payment."fromWalletId"<>NEW."walletId" OR payment."toWalletId"<>maker OR payment."amountMicros"<>NEW."costMicros" OR payment.kind<>'TRADE' THEN RAISE EXCEPTION 'invalid trade transfer'; END IF;
 ELSIF NEW."transferId" IS NOT NULL THEN
 SELECT * INTO payment FROM transfers WHERE id=NEW."transferId";
 IF payment."environmentId"<>NEW."environmentId" OR payment."toWalletId"<>NEW."walletId" OR payment."fromWalletId"<>maker OR payment."amountMicros"<>NEW."amountMicros" OR payment.kind NOT IN ('PAYOUT','VOID_REFUND') THEN RAISE EXCEPTION 'invalid payout transfer'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER trade_payment_link BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION validate_financial_link();
CREATE TRIGGER payout_payment_link BEFORE INSERT ON payouts FOR EACH ROW EXECUTE FUNCTION validate_financial_link();
REVOKE EXECUTE ON FUNCTION protect_commitment(),validate_financial_link() FROM PUBLIC;
CREATE INDEX evidence_submitter ON evidence("submittedByProfileId");
CREATE INDEX settlement_resolver ON settlements("resolvedByProfileId");
CREATE INDEX demo_actor ON demo_actions("actorProfileId");
CREATE INDEX chain_settlement ON chain_commitments("settlementId");
CREATE INDEX wallets_cash ON wallets("environmentId","balanceMicros" DESC,"profileId") WHERE kind='USER';
