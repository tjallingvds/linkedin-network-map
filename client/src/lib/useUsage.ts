/**
 * Fetches live usage + credit balance from /api/usage. Polls every 20s while
 * the tab is visible so numbers tick up after calls finish.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import type { UsageBucket } from "../components/Sidebar";

interface UsageResponse {
  buckets: UsageBucket[];
  costUsd?: number;
}

export function useUsage() {
  const [buckets, setBuckets] = useState<UsageBucket[]>([]);
  const [costUsd, setCostUsd] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = () => {
      api.get<UsageResponse>("/api/usage")
        .then((r) => {
          if (stopped) return;
          setBuckets(r.buckets ?? []);
          setCostUsd(r.costUsd ?? 0);
        })
        .catch(() => { /* keep previous values */ });
    };
    load();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 20_000);
    return () => { stopped = true; window.clearInterval(iv); };
  }, [tick]);

  return { buckets, costUsd, refresh: () => setTick((t) => t + 1) };
}
