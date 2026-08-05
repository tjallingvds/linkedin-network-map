"use client";

/** midday persists table settings (column visibility/size/order) in a cookie
 *  via a server action. Same behaviour, written client-side so no server
 *  action / auth session is needed. */
export async function updateTableSettingsAction({
  key,
  data,
}: {
  key: string;
  data: unknown;
}) {
  if (typeof document === "undefined") return;
  const value = encodeURIComponent(JSON.stringify(data));
  document.cookie = `${key}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}
