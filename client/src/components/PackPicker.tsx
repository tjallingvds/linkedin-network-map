/**
 * Credit pack picker. Fetches /api/billing/packs, renders 3 cards, and on
 * selection calls /api/billing/checkout { packId } which either:
 *   - redirects to Stripe Checkout (live)
 *   - or in mock mode, instantly grants credits so the UX is demoable
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IconClose, IconSparkle, IconCheck } from "../design/icons";

interface Pack {
  id: "starter" | "growth" | "scale";
  name: string;
  credits: number;
  amountCents: number;
  priceLabel: string;
  bonus?: string;
  popular?: boolean;
}

interface PacksResponse {
  balance: number;
  configured: boolean;
  packs: Pack[];
}

interface Props {
  onClose: () => void;
  onGranted: (credits: number) => void;
}

export function PackPicker({ onClose, onGranted }: Props) {
  const [data, setData] = useState<PacksResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<PacksResponse>("/api/billing/packs")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  const buy = async (pack: Pack) => {
    setBusyId(pack.id);
    setError(null);
    try {
      const r = await api.post<{ url: string | null; granted?: number; mock?: boolean }>(
        "/api/billing/checkout", { packId: pack.id },
      );
      if (r.url) {
        window.location.href = r.url;
        return;
      }
      if (r.granted) {
        onGranted(r.granted);
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="pack-modal">
        <div className="im-head">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Get more usage</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              Credits cover every search, enrichment, and outreach draft.
              {data ? ` Current balance: ${data.balance.toLocaleString()} credits.` : ""}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>

        {error && (
          <div style={{ padding: "10px 18px", color: "var(--danger)", fontSize: 13 }}>{error}</div>
        )}

        <div className="pack-grid">
          {(data?.packs ?? []).map((pack) => (
            <div key={pack.id} className={`pack-card ${pack.popular ? "popular" : ""}`}>
              {pack.popular && <div className="pack-badge">Most popular</div>}
              <div className="pack-name">{pack.name}</div>
              <div className="pack-price">{pack.priceLabel}</div>
              <div className="pack-credits">
                <IconSparkle size={12} style={{ color: "var(--accent)" }} />
                <strong>{pack.credits.toLocaleString()}</strong> credits
              </div>
              {pack.bonus && <div className="pack-bonus">{pack.bonus}</div>}
              <ul className="pack-detail">
                <li><IconCheck size={11} /> ~{Math.floor(pack.credits / 5)} searches</li>
                <li><IconCheck size={11} /> ~{pack.credits.toLocaleString()} Apollo enrichments</li>
                <li><IconCheck size={11} /> ~{(pack.credits * 2000).toLocaleString()} LLM tokens</li>
              </ul>
              <button
                className={`pill-btn ${pack.popular ? "primary" : ""}`}
                style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
                disabled={busyId === pack.id}
                onClick={() => buy(pack)}
              >
                {busyId === pack.id ? "Opening Stripe…" : `Buy ${pack.priceLabel}`}
              </button>
            </div>
          ))}
          {!data && (
            <div style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center", color: "var(--text-mute)" }}>
              Loading packs…
            </div>
          )}
        </div>

        <div style={{
          padding: "12px 18px",
          fontSize: 11,
          color: "var(--text-mute)",
          borderTop: "1px solid var(--hairline)",
          textAlign: "center",
        }}>
          One-time purchase, credits don't expire. Stripe handles VAT & taxes where applicable.
        </div>
      </div>
    </>
  );
}
