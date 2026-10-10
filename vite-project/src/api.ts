import { createClient, type SupabaseClient } from "@supabase/supabase-js";
export let supabase: SupabaseClient | null = null;
export interface Config {
  localDemoAuth: boolean;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  mapStyle: string | null;
}
export async function configure() {
  const c = await request<Config>("/config");
  if (!supabase && c.supabaseUrl && c.supabasePublishableKey)
    supabase = createClient(c.supabaseUrl, c.supabasePublishableKey);
  return c;
}
export async function request<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const session = supabase
      ? (await supabase.auth.getSession()).data.session
      : null,
    token = session?.access_token ?? sessionStorage.getItem("demo-token");
  const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");
  const r = await fetch(`${apiOrigin}/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.code ?? "Request failed");
  return data;
}
export const dollars = (value: string | bigint, precision: 2 | 6 = 2) => {
  const n = BigInt(value),
    negative = n < 0n,
    a = negative ? -n : n;
  return `${negative ? "-" : ""}$R ${(a / 1000000n).toLocaleString("en-US")}.${((a % 1000000n) / (precision === 6 ? 1n : 10000n)).toString().padStart(precision, "0")}`;
};
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
