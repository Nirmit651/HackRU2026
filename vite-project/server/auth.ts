import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { db, ensure } from "./db";
const secret = randomBytes(32);
const demoAdminSecret = process.env.DEMO_ADMIN_SESSION_SECRET ?? process.env.DEMO_ADMIN_PASSWORD ?? "development-only-demo-admin";
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
    : null;
export const localDemo =
  process.env.LOCAL_DEMO_AUTH === "true" &&
  process.env.NODE_ENV !== "production";
export function demoToken(id: string) {
  const data = Buffer.from(
    JSON.stringify({ id, expires: Date.now() + 86400000 }),
  ).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
export async function identity(req: Request) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  ensure(token, "UNAUTHORIZED", 401);
  if (localDemo && token.includes(".")) {
    const [data, sig] = token.split(".");
    const expected = createHmac("sha256", secret)
      .update(data)
      .digest("base64url");
    if (
      sig?.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      const info = JSON.parse(Buffer.from(data, "base64url").toString());
      ensure(info.expires > Date.now(), "UNAUTHORIZED", 401);
      return {
        profile: await db.profile.findUniqueOrThrow({ where: { id: info.id } }),
        admin: true,
        local: true,
      };
    }
  }
  ensure(supabase, "AUTH_UNAVAILABLE", 503);
  const { data, error } = await supabase.auth.getUser(token);
  ensure(!error && data.user, "UNAUTHORIZED", 401);
  const u = data.user,
    profile = await db.profile.upsert({
      where: { authUserId: u.id },
      create: {
        authUserId: u.id,
        handle: `student-${u.id}`,
        displayName: "Rutgers trader",
        kind: "HUMAN",
      },
      update: {},
    });
  return { profile, admin: u.app_metadata.role === "admin", local: false };
}
export async function scopedIdentity(req: Request, environmentId: string) {
  const user = await identity(req);
  if (user.local) {
    const env = await db.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
    ensure(env.kind === "DEMO", "FORBIDDEN", 403);
  }
  return user;
}
export async function admin(req: Request) {
  const user = await identity(req);
  ensure(user.admin, "FORBIDDEN", 403);
  return user;
}

function demoAdminSignature(data: string) {
  return createHmac("sha256", demoAdminSecret).update(data).digest("base64url");
}
export function issueDemoAdminSession() {
  const data = Buffer.from(JSON.stringify({ expires: Date.now() + 6 * 60 * 60 * 1000 })).toString("base64url");
  return `${data}.${demoAdminSignature(data)}`;
}
export function demoAdmin(req: Request) {
  const cookie = req.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("scarlet_demo_admin="))?.slice("scarlet_demo_admin=".length);
  ensure(cookie, "DEMO_ADMIN_REQUIRED", 401);
  const [data, sig] = cookie.split("."), expected = demoAdminSignature(data ?? "");
  ensure(!!sig && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)), "DEMO_ADMIN_REQUIRED", 401);
  const value = JSON.parse(Buffer.from(data!, "base64url").toString()) as { expires?: number };
  ensure((value.expires ?? 0) > Date.now(), "DEMO_ADMIN_REQUIRED", 401);
  return true;
}
export function verifyDemoAdminPassword(password: string) {
  const expected = process.env.DEMO_ADMIN_PASSWORD;
  ensure(expected && password.length === expected.length && timingSafeEqual(Buffer.from(password), Buffer.from(expected)), "INVALID_DEMO_ADMIN_PASSWORD", 401);
  return true;
}
