import { it, expect } from "vitest";
import { validatePublishedMemo } from "../server/chain";
const tx = {
  meta: { err: null },
  transaction: {
    message: {
      accountKeys: [{ pubkey: "expected", signer: true }],
      instructions: [
        {
          programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          parsed: "scarlet:rutgers-v1:SETTLEMENT:abc",
        },
      ],
    },
  },
};
it("checks the signer, memo program and exact committed hash", () => {
  expect(validatePublishedMemo(tx, "expected", "SETTLEMENT", "abc")).toBe(true);
  expect(validatePublishedMemo(tx, "wrong", "SETTLEMENT", "abc")).toBe(false);
  expect(validatePublishedMemo(tx, "expected", "SETTLEMENT", "tampered")).toBe(
    false,
  );
  expect(
    validatePublishedMemo(
      { ...tx, meta: { err: "failed" } },
      "expected",
      "SETTLEMENT",
      "abc",
    ),
  ).toBe(false);
});
