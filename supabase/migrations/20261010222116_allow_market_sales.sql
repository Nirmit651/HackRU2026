CREATE TYPE "TradeAction" AS ENUM ('BUY', 'SELL');
ALTER TABLE "trades" ADD COLUMN "action" "TradeAction" NOT NULL DEFAULT 'BUY';
ALTER TYPE "TransferKind" ADD VALUE IF NOT EXISTS 'SALE';
CREATE OR REPLACE FUNCTION validate_financial_link() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE payment transfers; maker uuid; BEGIN
 SELECT "marketMakerWalletId" INTO maker FROM markets WHERE id=NEW."marketId";
 IF TG_TABLE_NAME='trades' THEN
   SELECT * INTO payment FROM transfers WHERE id=NEW."paymentTransferId";
   IF payment."environmentId"<>NEW."environmentId" OR payment."amountMicros"<>NEW."costMicros" OR
      (NEW.action='BUY' AND (payment."fromWalletId"<>NEW."walletId" OR payment."toWalletId"<>maker OR payment.kind::text<>'TRADE')) OR
      (NEW.action='SELL' AND (payment."fromWalletId"<>maker OR payment."toWalletId"<>NEW."walletId" OR payment.kind::text<>'SALE'))
   THEN RAISE EXCEPTION 'invalid trade transfer'; END IF;
 ELSIF NEW."transferId" IS NOT NULL THEN
   SELECT * INTO payment FROM transfers WHERE id=NEW."transferId";
   IF payment."environmentId"<>NEW."environmentId" OR payment."toWalletId"<>NEW."walletId" OR payment."fromWalletId"<>maker OR payment."amountMicros"<>NEW."amountMicros" OR payment.kind NOT IN ('PAYOUT','VOID_REFUND') THEN RAISE EXCEPTION 'invalid payout transfer'; END IF;
 END IF; RETURN NEW;
END $$;
