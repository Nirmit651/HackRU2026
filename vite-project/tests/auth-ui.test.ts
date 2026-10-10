import { describe, expect, it } from "vitest";
import { friendlyAuthError, validateAuthFields } from "../src/AuthDialog";

describe("authentication form rules", () => {
  it("requires matching passwords before signup", () => {
    expect(validateAuthFields({ local: false, mode: "signup", name: "trader@example.edu", password: "hunter2", confirmPassword: "different" })).toBe("Passwords do not match.");
  });
  it("does not require a password in local demo authentication", () => {
    expect(validateAuthFields({ local: true, mode: "signup", name: "Demo trader", password: "", confirmPassword: "" })).toBeNull();
  });
  it("maps explicit duplicate signup and invalid sign-in safely", () => {
    expect(friendlyAuthError(new Error("User already registered"), "signup")).toBe("An account already exists for this email. Sign in instead.");
    expect(friendlyAuthError(new Error("Invalid login credentials"), "signin")).toBe("Incorrect email or password.");
  });
});
