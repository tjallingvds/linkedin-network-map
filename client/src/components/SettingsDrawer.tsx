/**
 * Settings — per-user API keys (localStorage) + usage overview.
 *
 * Keys live in localStorage only; when set, the client sends them as
 * `X-User-{Provider}-Key` headers with each request so the server can prefer
 * the user's key over its own. (Server wiring of those headers is a follow-up.)
 */
import { useEffect, useState } from "react";
import { IconClose, IconUpload, IconUsers } from "../design/icons";
import type { UsageBucket } from "./Sidebar";
import { api } from "../lib/api";

const KEY_STORE = "nontrivial.apiKeys.v1";

export interface ApiKeys {
  openai?: string;
  anthropic?: string;
  deepseek?: string;
  tavily?: string;
  apollo?: string;
}

/** Strip the most common copy-paste pollutants so a key never lands in
 *  localStorage with chars that fetch() can't put in a header (smart quotes,
 *  em-dashes, NBSP, zero-width spaces, BOMs, control chars). */
function sanitizeApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim();
  return cleaned || undefined;
}

function sanitizeAll(k: ApiKeys): ApiKeys {
  return {
    openai: sanitizeApiKey(k.openai),
    anthropic: sanitizeApiKey(k.anthropic),
    deepseek: sanitizeApiKey(k.deepseek),
    tavily: sanitizeApiKey(k.tavily),
    apollo: sanitizeApiKey(k.apollo),
  };
}

export function loadApiKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    return raw ? sanitizeAll(JSON.parse(raw) as ApiKeys) : {};
  } catch {
    return {};
  }
}

function saveApiKeys(k: ApiKeys) {
  localStorage.setItem(KEY_STORE, JSON.stringify(sanitizeAll(k)));
}

interface Props {
  open: boolean;
  usage: UsageBucket[];
  onClose: () => void;
  onFlash: (msg: string) => void;
  /** Opens the LinkedIn connections / invitations import modal. */
  onImportLinkedIn?: () => void;
  /** Fired after successfully joining a shared board, so the parent can
   *  refresh the boards list and jump to the new board. */
  onBoardJoined?: (boardId: string) => void;
}

export function SettingsDrawer({ open, usage, onClose, onFlash, onImportLinkedIn, onBoardJoined }: Props) {
  const [keys, setKeys] = useState<ApiKeys>(() => loadApiKeys());
  const [dirty, setDirty] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  const join = async () => {
    const token = joinCode.trim();
    if (!token) return;
    setJoining(true);
    try {
      const r = await api.post<{ boardId: string; name: string; alreadyMember?: boolean }>(`/api/crm/share/${token}/join`);
      onFlash(r.alreadyMember ? `You already have "${r.name}".` : `Joined "${r.name}".`);
      setJoinCode("");
      onBoardJoined?.(r.boardId);
    } catch (e) {
      onFlash(`Join failed: ${(e as Error).message}`);
    } finally { setJoining(false); }
  };

  useEffect(() => {
    if (open) setKeys(loadApiKeys());
  }, [open]);

  if (!open) return null;

  const setKey = (k: keyof ApiKeys, v: string) => {
    setKeys((prev) => ({ ...prev, [k]: v }));
    setDirty(true);
  };

  const save = () => {
    saveApiKeys(keys);
    setDirty(false);
    onFlash("API keys saved locally");
  };

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Settings</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              API providers & usage
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={16} /></button>
        </div>

        <div className="drawer-body">
          <section>
            <div className="section-title">Usage this month</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {usage.map((u) => {
                const pct = u.max > 0 ? Math.min(100, Math.round((u.used / u.max) * 100)) : 0;
                const over = pct > 90;
                return (
                  <div key={u.label} style={{ padding: "10px 12px", background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text)", marginBottom: 6 }}>
                      <span style={{ fontWeight: 500 }}>{u.label}</span>
                      <span style={{ fontFamily: "Geist Mono, monospace", color: over ? "var(--danger)" : "var(--text-dim)" }}>
                        {u.used.toLocaleString()} / {u.max.toLocaleString()}{u.unit}
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--hairline)", overflow: "hidden" }}>
                      <div style={{
                        width: `${pct}%`, height: "100%",
                        background: over ? "var(--danger)" : "var(--accent)",
                        transition: "width 200ms",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="section-title">Join a shared board</div>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 10 }}>
              Paste the share code a teammate sent you. You'll get read + write access to their CRM board.
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") join(); }}
                placeholder="e.g. ABC23XYZ8KLM"
                style={{
                  flex: 1, padding: "8px 10px",
                  background: "var(--panel)", border: "1px solid var(--hairline)",
                  borderRadius: 8, color: "var(--text)", fontSize: 13,
                  fontFamily: "Geist Mono, monospace", letterSpacing: "0.1em",
                }}
              />
              <button
                className="pill-btn primary"
                onClick={join}
                disabled={!joinCode.trim() || joining}
              >
                <IconUsers size={12} />{joining ? "Joining…" : "Join"}
              </button>
            </div>
          </section>

          {onImportLinkedIn && (
            <section>
              <div className="section-title">Your LinkedIn network</div>
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 10 }}>
                Import <code>Connections.csv</code> or <code>Invitations.csv</code> from your LinkedIn
                data export. Once imported, "My network" chat mode can search across them.
              </div>
              <button className="pill-btn" onClick={onImportLinkedIn}>
                <IconUpload size={12} />Import from LinkedIn
              </button>
            </section>
          )}

          <section>
            <div className="section-title">Connect your own API keys</div>
            <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 10 }}>
              Stored only in your browser. When set, your requests use your keys instead of the workspace defaults.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <KeyField label="OpenAI" value={keys.openai ?? ""} onChange={(v) => setKey("openai", v)} placeholder="sk-…" />
              <KeyField label="Anthropic (Claude)" value={keys.anthropic ?? ""} onChange={(v) => setKey("anthropic", v)} placeholder="sk-ant-…" />
              <KeyField label="DeepSeek" value={keys.deepseek ?? ""} onChange={(v) => setKey("deepseek", v)} />
              <KeyField label="Tavily (web search)" value={keys.tavily ?? ""} onChange={(v) => setKey("tavily", v)} placeholder="tvly-…" />
              <KeyField label="Apollo.io (enrichment)" value={keys.apollo ?? ""} onChange={(v) => setKey("apollo", v)} />
            </div>
          </section>
        </div>

        <div className="drawer-foot">
          <button className="pill-btn" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="pill-btn primary" disabled={!dirty} onClick={save}>
            Save keys
          </button>
        </div>
      </div>
    </>
  );
}

function KeyField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-mute)" }}>
        {label}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            padding: "8px 10px",
            background: "var(--panel)",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            color: "var(--text)",
            fontSize: 12.5,
            fontFamily: "Geist Mono, monospace",
          }}
        />
        <button
          type="button"
          className="pill-btn"
          onClick={() => setShow((s) => !s)}
          style={{ fontSize: 11 }}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
    </label>
  );
}
