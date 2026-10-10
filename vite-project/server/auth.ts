import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { db, ensure } from "./db";
const secret = randomBytes(32);
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
