import { describe, expect, it } from "vitest";
import { demoAdmin, demoAdminSessionSeconds, issueDemoAdminSession, verifyDemoAdminPassword } from "../server/auth";

describe("presentation admin session", () => {
  it("issues a signed persistent cookie that is accepted on privileged routes", () => {
    process.env.DEMO_ADMIN_PASSWORD = "admin";
    expect(verifyDemoAdminPassword("admin")).toBe(true);
    const token = issueDemoAdminSession();
    const [data] = token.split(".");
    expect(JSON.parse(Buffer.from(data!, "base64url").toString()).expires).toBeGreaterThan(Date.now() + (demoAdminSessionSeconds - 60) * 1000);
    expect(demoAdmin({ headers: { cookie: `scarlet_demo_admin=${token}` } } as never)).toBe(true);
    expect(() => demoAdmin({ headers: { cookie: "scarlet_demo_admin=invalid" } } as never)).toThrow("DEMO_ADMIN_REQUIRED");
  });
});
