/**
 * ConnectionsImportModal — imports a LinkedIn data export into the user's
 * people table OR message log. Accepts:
 *   - `Connections.csv`  → POST /api/people/bulk      (powers Network search)
 *   - `Invitations.csv`  → POST /api/people/bulk      (pending invites)
 *   - `messages.csv`     → POST /api/messages-log/bulk (powers "haven't
 *                          messaged yet" filter in Network search)
 *
 * LinkedIn schemas (vary slightly across exports):
 *   Connections.csv: First Name, Last Name, URL, Email Address, Company,
 *                    Position, Connected On
 *   Invitations.csv: From, To, Message, Sent At, Direction
 *   messages.csv:    CONVERSATION ID, CONVERSATION TITLE, FROM,
 *                    SENDER PROFILE URL, TO, RECIPIENT PROFILE URLS,
 *                    DATE, SUBJECT, CONTENT, FOLDER
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { IconClose, IconUpload, IconCheck, IconArrowR } from "../design/icons";
import {
  parseLinkedIn,
  parseLinkedInMessages,
  type NetworkImportRow,
  type MessageImportRow,
  type ParsedMessages,
} from "../lib/linkedinCsv";

type Kind = "connections" | "invitations" | "messages";

/** Render a Postgres timestamp as "2 hours ago" / "3 days ago" / "Apr 12".
 *  Used in the existing-data card so the user immediately sees how recent
 *  their loaded import is. */
function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const diffMs = Date.now() - t;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ConnectionsImportModal({
  onClose, onFlash, onImported,
}: {
  onClose: () => void;
  onFlash: (msg: string) => void;
  onImported?: (inserted: number) => void;
}) {
  const [kind, setKind] = useState<Kind>("connections");
  const [text, setText] = useState("");
  const [step, setStep] = useState<"paste" | "preview">("paste");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** When the user overrides the auto-detected "you" name in the messages
   *  preview, store it here so the parser re-runs with the override. */
  const [userNameOverride, setUserNameOverride] = useState<string>("");
  /** Existing-data status for whichever tab is open. Lets the user see
   *  "you already have 1,247 messages loaded" before they upload again. */
  const [existing, setExisting] = useState<{
    connections?: { total: number };
    messages?: { total: number; sent: number; uniqueCounterparts: number; lastImportedAt: string | null };
  }>({});
  const [clearing, setClearing] = useState(false);

  // Load existing-state for the active tab whenever it changes. People-table
  // count for connections/invitations, message_log stats for messages.
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        if (kind === "messages") {
          const stats = await api.get<{
            total: number; sent: number; received: number; uniqueCounterparts: number; lastImportedAt: string | null;
          }>("/api/messages-log/stats");
          if (!stale) setExisting((e) => ({ ...e, messages: {
            total: stats.total, sent: stats.sent, uniqueCounterparts: stats.uniqueCounterparts, lastImportedAt: stats.lastImportedAt,
          } }));
        } else {
          // /api/people supports limit=1 — we only need the count, but the
          // route returns rows. Cheap enough for the modal mount.
          const r = await api.get<{ people: unknown[] }>("/api/people?limit=1&offset=0");
          // The response shape doesn't include a total; fall back to the
          // length we got back. For the more accurate count we'd add a
          // dedicated /count endpoint — overkill for now.
          if (!stale) setExisting((e) => ({ ...e, connections: { total: r.people.length > 0 ? -1 : 0 } }));
        }
      } catch { /* non-fatal */ }
    })();
    return () => { stale = true; };
  }, [kind]);

  const clearMessageLog = async () => {
    setClearing(true);
    try {
      await api.del("/api/messages-log");
      setExisting((e) => ({ ...e, messages: { total: 0, sent: 0, uniqueCounterparts: 0, lastImportedAt: null } }));
      onFlash("Cleared message log");
    } catch (err) {
      onFlash(`Clear failed: ${(err as Error).message}`);
    } finally {
      setClearing(false);
    }
  };

  // Network preview (connections | invitations).
  const networkPreview = useMemo<NetworkImportRow[]>(() => {
    if (kind === "messages" || !text.trim()) return [];
    return parseLinkedIn(text, kind).slice(0, 10_000);
  }, [text, kind]);

  // Messages preview — separate parser, separate row shape.
  const messagesPreview = useMemo<ParsedMessages>(() => {
    if (kind !== "messages" || !text.trim()) {
      return { rows: [], detectedUserName: "", candidateUserNames: [] };
    }
    return parseLinkedInMessages(text, { overrideUserName: userNameOverride || undefined });
  }, [text, kind, userNameOverride]);

  // Single number both branches read for the footer / preview header.
  const previewCount = kind === "messages" ? messagesPreview.rows.length : networkPreview.length;

  const onPickFile = async (file: File) => {
    const raw = await file.text();
    setText(raw);
    setUserNameOverride("");
    const low = file.name.toLowerCase();
    if (low.includes("invitation")) setKind("invitations");
    else if (low.includes("message")) setKind("messages");
    else if (low.includes("connection")) setKind("connections");
  };

  const handleImport = async () => {
    setSaving(true);
    try {
      if (kind === "messages") {
        const sent = messagesPreview.rows.filter((m) => m.direction === "sent").length;
        const res = await api.post<{ inserted: number; total: number }>(
          "/api/messages-log/bulk",
          {
            messages: messagesPreview.rows.map((m) => ({
              conversationId: m.conversationId,
              counterpartName: m.counterpartName,
              counterpartLinkedinUrl: m.counterpartLinkedinUrl ?? null,
              direction: m.direction,
              messageDate: m.messageDate ?? null,
              subject: m.subject ?? null,
              contentSnippet: m.contentSnippet ?? null,
            })),
            // Re-importing a fresh export should replace, not double-count.
            replace: true,
          },
        );
        onImported?.(res.inserted);
        onFlash(
          `Imported ${res.inserted.toLocaleString()} messages` +
            (sent > 0 ? ` — ${sent.toLocaleString()} sent by you` : ""),
        );
        // The CRM's "Connected & new" filter folds messaged-sent people
        // into its hide set — let it refresh without a hard reload.
        window.dispatchEvent(new CustomEvent("messages-imported"));
        onClose();
        return;
      }

      const payload = {
        people: networkPreview.map((p) => ({
          firstName: p.firstName,
          lastName: p.lastName,
          company: p.company ?? null,
          position: p.position ?? null,
          linkedinUrl: p.linkedinUrl ?? null,
          email: p.email ?? null,
          connectedOn: p.connectedOn ?? null,
          category: p.category ?? null,
        })),
        // Tag the rows so the server can later distinguish a sent
        // invitation from a real connection — used by the CRM filter
        // "show only people I haven't connected to yet".
        kind: kind === "invitations" ? "invitation" as const : "connection" as const,
        // A fresh export should replace the user's previous rows of
        // this kind so duplicates don't pile up on re-import.
        replace: true,
      };
      const res = await api.post<{ inserted: number }>("/api/people/bulk", payload);
      onImported?.(res.inserted);
      onFlash(`Imported ${res.inserted.toLocaleString()} ${kind === "invitations" ? "invites" : "connections"}`);
      // Tell other parts of the app (the CRM's "Connected & new" filter)
      // to refresh their match cache without a hard reload.
      if (kind === "invitations") {
        window.dispatchEvent(new CustomEvent("invitations-imported"));
      } else if (kind === "connections") {
        window.dispatchEvent(new CustomEvent("connections-imported"));
      }
      onClose();
    } catch (err) {
      onFlash(`Import failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // Drag-and-drop: let users drop a CSV on the modal.
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="import-modal">
        <div className="im-head">
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              Import from LinkedIn
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              Upload <code>Connections.csv</code>, <code>Invitations.csv</code>, or{" "}
              <code>messages.csv</code> from your LinkedIn data export.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>

        {step === "paste" ? (
          <>
            <div className="im-body">
              <div className="im-dest-row" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button
                  className={`pill-btn ${kind === "connections" ? "primary" : ""}`}
                  onClick={() => setKind("connections")}
                  style={{ fontSize: 11.5 }}
                >
                  Connections
                </button>
                <button
                  className={`pill-btn ${kind === "invitations" ? "primary" : ""}`}
                  onClick={() => setKind("invitations")}
                  style={{ fontSize: 11.5 }}
                >
                  Pending invites
                </button>
                <button
                  className={`pill-btn ${kind === "messages" ? "primary" : ""}`}
                  onClick={() => setKind("messages")}
                  style={{ fontSize: 11.5 }}
                >
                  Messages
                </button>
              </div>
              {kind === "messages" && (
                <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8, lineHeight: 1.45 }}>
                  We use this to power "haven't messaged yet" filters in Network search — so
                  you only see fresh contacts. Messages stay on the server keyed to your account.
                </div>
              )}

              {/* Existing-data card — shows the user what's already loaded
                  for the active tab so they don't blindly re-upload. */}
              {kind === "messages" && existing.messages && existing.messages.total > 0 && (
                <div style={{
                  background: "linear-gradient(180deg, oklch(0.97 0.03 155 / 0.55), oklch(0.95 0.04 155 / 0.4))",
                  border: "1px solid oklch(0.7 0.13 155 / 0.3)",
                  borderRadius: 10, padding: "10px 12px", marginBottom: 10,
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                }}>
                  <IconCheck size={14} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                      You already have a message log loaded
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 2 }}>
                      {existing.messages.total.toLocaleString()} messages
                      {existing.messages.sent > 0 && ` · ${existing.messages.sent.toLocaleString()} sent`}
                      {existing.messages.uniqueCounterparts > 0 && ` · ${existing.messages.uniqueCounterparts.toLocaleString()} unique people`}
                      {existing.messages.lastImportedAt && ` · last uploaded ${formatRelativeDate(existing.messages.lastImportedAt)}`}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginTop: 4, lineHeight: 1.4 }}>
                      Uploading a new file will <strong>replace</strong> this set.
                    </div>
                  </div>
                  <button
                    className="pill-btn"
                    onClick={clearMessageLog}
                    disabled={clearing}
                    style={{ fontSize: 11 }}
                    title="Wipe the existing message log"
                  >
                    {clearing ? "Clearing…" : "Clear"}
                  </button>
                </div>
              )}
              {(kind === "connections" || kind === "invitations") && existing.connections && existing.connections.total !== 0 && (
                <div style={{
                  background: "linear-gradient(180deg, oklch(0.97 0.03 155 / 0.55), oklch(0.95 0.04 155 / 0.4))",
                  border: "1px solid oklch(0.7 0.13 155 / 0.3)",
                  borderRadius: 10, padding: "10px 12px", marginBottom: 10,
                  fontSize: 12, color: "var(--text)",
                }}>
                  <strong>Heads up:</strong> you already have {kind} loaded. Uploading a
                  new file will <strong>replace</strong> this set — the old rows are
                  cleared first, so nothing double-counts.
                </div>
              )}

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) await onPickFile(f);
                }}
                style={{
                  border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--hairline)"}`,
                  borderRadius: 10,
                  padding: 14,
                  background: dragOver ? "var(--accent-soft)" : "var(--panel)",
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--text-dim)",
                  marginBottom: 10,
                  transition: "all 160ms ease",
                }}
              >
                Drop <strong>{
                  kind === "invitations" ? "Invitations.csv" :
                  kind === "messages" ? "messages.csv" :
                  "Connections.csv"
                }</strong> here,
                or <button className="tool" onClick={() => fileRef.current?.click()} style={{ fontSize: 12 }}>
                  <IconUpload size={12} />browse
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickFile(f);
                  e.target.value = "";
                }}
              />

              <textarea
                className="im-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="…or paste the CSV contents here"
                style={{ minHeight: 120 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <a
                  href="https://www.linkedin.com/mypreferences/d/download-my-data"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11.5, color: "var(--accent)" }}
                >
                  How to export from LinkedIn →
                </a>
                <div style={{ fontSize: 11, color: "var(--text-mute)", fontFamily: "Geist Mono, monospace" }}>
                  {text.trim() ? `${previewCount.toLocaleString()} detected` : "empty"}
                </div>
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={onClose}>Cancel</button>
              <button className="pill-btn primary" disabled={previewCount === 0} onClick={() => setStep("preview")}>
                Preview <IconArrowR size={12} />
              </button>
            </div>
          </>
        ) : kind === "messages" ? (
          <>
            <div className="im-body">
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Preview — {messagesPreview.rows.length.toLocaleString()} message
                {messagesPreview.rows.length === 1 ? "" : "s"} from{" "}
                {new Set(messagesPreview.rows.map((m) => m.counterpartName.toLowerCase())).size.toLocaleString()} counterpart
                {new Set(messagesPreview.rows.map((m) => m.counterpartName.toLowerCase())).size === 1 ? "" : "s"}.
              </div>

              <div style={{
                background: "var(--panel)", border: "1px solid var(--hairline)",
                borderRadius: 10, padding: "10px 12px", marginBottom: 10,
              }}>
                <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 4 }}>
                  We auto-detected your name as
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13, color: "var(--text)" }}>
                    {messagesPreview.detectedUserName || <em>(none — try overriding)</em>}
                  </strong>
                  {messagesPreview.candidateUserNames.length > 1 && (
                    <span style={{ fontSize: 11, color: "var(--text-mute)" }}>
                      — wrong?
                    </span>
                  )}
                </div>
                {messagesPreview.candidateUserNames.length > 1 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {messagesPreview.candidateUserNames.slice(0, 4).map((c) => (
                      <button
                        key={c.name}
                        className={`pill-btn ${c.name === messagesPreview.detectedUserName ? "primary" : ""}`}
                        onClick={() => setUserNameOverride(c.name)}
                        style={{ fontSize: 11 }}
                        title={`${c.count.toLocaleString()} messages from this name`}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginTop: 6, lineHeight: 1.4 }}>
                  This decides which messages count as "sent" vs "received". The "haven't messaged
                  yet" filter only excludes people you've actually <em>sent</em> to.
                </div>
              </div>

              <div className="im-preview">
                <div className="im-prev-head">
                  <span>Direction</span><span>Counterpart</span><span>When</span><span>Subject / preview</span>
                </div>
                {messagesPreview.rows.slice(0, 20).map((m, i) => (
                  <div key={i} className="im-prev-row">
                    <span>
                      {m.direction === "sent" ? (
                        <span style={{ color: "var(--accent)" }}>→ sent</span>
                      ) : (
                        <span style={{ color: "var(--text-mute)" }}>← received</span>
                      )}
                    </span>
                    <span>{m.counterpartName || <em>—</em>}</span>
                    <span>{m.messageDate?.split(" ")[0] || <em>—</em>}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.subject || m.contentSnippet || <em>—</em>}
                    </span>
                  </div>
                ))}
                {messagesPreview.rows.length > 20 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-mute)" }}>
                    + {(messagesPreview.rows.length - 20).toLocaleString()} more…
                  </div>
                )}
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("paste")}>← Back</button>
              <button
                className="pill-btn primary"
                disabled={saving || messagesPreview.rows.length === 0 || !messagesPreview.detectedUserName}
                onClick={handleImport}
              >
                <IconCheck size={12} />
                {saving ? "Importing…" : `Import ${messagesPreview.rows.length.toLocaleString()} (replaces existing)`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="im-body">
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Preview — {networkPreview.length.toLocaleString()} {kind === "invitations" ? "invite" : "connection"}
                {networkPreview.length === 1 ? "" : "s"} will be added to your network.
              </div>
              <div className="im-preview">
                <div className="im-prev-head">
                  <span>Name</span><span>Company</span><span>Title</span><span>When</span>
                </div>
                {networkPreview.slice(0, 20).map((p, i) => (
                  <div key={i} className="im-prev-row">
                    <span>{[p.firstName, p.lastName].filter((v) => v && v !== "—").join(" ") || <em>—</em>}</span>
                    <span>{p.company || <em>—</em>}</span>
                    <span>{p.position || <em>—</em>}</span>
                    <span>{p.connectedOn || <em>—</em>}</span>
                  </div>
                ))}
                {networkPreview.length > 20 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-mute)" }}>
                    + {(networkPreview.length - 20).toLocaleString()} more…
                  </div>
                )}
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("paste")}>← Back</button>
              <button className="pill-btn primary" disabled={saving} onClick={handleImport}>
                <IconCheck size={12} />{saving ? "Importing…" : `Import ${networkPreview.length.toLocaleString()}`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
