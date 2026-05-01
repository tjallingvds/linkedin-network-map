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

export interface NetworkImportRow {
  firstName: string;
  lastName: string;
  company?: string;
  position?: string;
  linkedinUrl?: string;
  email?: string;
  connectedOn?: string;
  category?: string; // e.g., "pending_invite" when importing invitations
}

// ---- CSV parsing (handles quoted fields + escaped quotes) ----
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (cur.length || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * LinkedIn's CSV has a "Notes" block above the real header — blank lines plus
 * a paragraph about exporting data. Skip everything until we hit a line that
 * looks like a real header row.
 */
function parseLinkedIn(text: string, kind: "connections" | "invitations"): NetworkImportRow[] {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];

  // Find the first row that contains expected headers.
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const lowered = rows[i]!.map((c) => c.toLowerCase().trim());
    if (kind === "connections") {
      if (lowered.includes("first name") || lowered.includes("firstname") || lowered.includes("company")) {
        headerIdx = i; break;
      }
    } else {
      if (lowered.includes("from") || lowered.includes("inviter") || lowered.includes("sender")) {
        headerIdx = i; break;
      }
    }
  }
  if (headerIdx === -1) return [];

  const header = rows[headerIdx]!.map((h) => h.toLowerCase().trim());
  const data = rows.slice(headerIdx + 1);

  // Map header index → our field
  const col = (...candidates: string[]) =>
    candidates.map((c) => header.indexOf(c)).find((i) => i !== -1) ?? -1;

  if (kind === "connections") {
    const iFirst = col("first name", "firstname");
    const iLast = col("last name", "lastname");
    const iCompany = col("company", "current company");
    const iPosition = col("position", "current position", "title");
    const iUrl = col("url", "profile url", "linkedin url");
    const iEmail = col("email address", "email");
    const iConnected = col("connected on", "connection date");
    const out: NetworkImportRow[] = [];
    for (const r of data) {
      const firstName = iFirst !== -1 ? r[iFirst]?.trim() ?? "" : "";
      const lastName = iLast !== -1 ? r[iLast]?.trim() ?? "" : "";
      if (!firstName && !lastName) continue;
      out.push({
        firstName: firstName || "—",
        lastName: lastName || "—",
        company: iCompany !== -1 ? r[iCompany]?.trim() || undefined : undefined,
        position: iPosition !== -1 ? r[iPosition]?.trim() || undefined : undefined,
        linkedinUrl: iUrl !== -1 ? r[iUrl]?.trim() || undefined : undefined,
        email: iEmail !== -1 ? r[iEmail]?.trim() || undefined : undefined,
        connectedOn: iConnected !== -1 ? r[iConnected]?.trim() || undefined : undefined,
      });
    }
    return out;
  }

  // Invitations: rows have a From (name) which we split into first/last.
  const iFrom = col("from", "inviter", "sender", "name");
  const iSent = col("sent at", "date", "sent");
  const out: NetworkImportRow[] = [];
  for (const r of data) {
    const raw = iFrom !== -1 ? r[iFrom]?.trim() ?? "" : "";
    if (!raw) continue;
    const parts = raw.split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? "—";
    const lastName = parts.slice(1).join(" ") || "—";
    out.push({
      firstName,
      lastName,
      connectedOn: iSent !== -1 ? r[iSent]?.trim() || undefined : undefined,
      category: "pending_invite",
    });
  }
  return out;
}

type Kind = "connections" | "invitations" | "messages";

// ---- Messages parsing ----------------------------------------------------
//
// LinkedIn's messages.csv lists EVERY message in EVERY conversation. We need
// to know which side is "you" (so we can mark each row as sent vs. received).
// We auto-detect: the FROM value that appears in the most rows is almost
// certainly the user (over time, you've sent more total messages than any
// single counterpart — this holds even if you have one very chatty contact).
// Counterpart = the OTHER party (= TO when direction=sent, = FROM when
// direction=received). For group chats (multiple TOs) we record each TO
// as its own counterpart row.

export interface MessageImportRow {
  conversationId?: string;
  counterpartName: string;
  counterpartLinkedinUrl?: string;
  direction: "sent" | "received";
  messageDate?: string;
  subject?: string;
  contentSnippet?: string;
}

interface ParsedMessages {
  rows: MessageImportRow[];
  /** The name we auto-detected as the user — shown in the preview so they
   *  can confirm or override before importing. */
  detectedUserName: string;
  /** Distinct count of names appearing as the inferred user. Used for the
   *  preview hint when the auto-detect is uncertain. */
  candidateUserNames: { name: string; count: number }[];
}

function parseLinkedInMessages(text: string, overrideUserName?: string): ParsedMessages {
  const empty: ParsedMessages = { rows: [], detectedUserName: "", candidateUserNames: [] };
  const rows = parseCSV(text);
  if (rows.length === 0) return empty;

  // Find the header — same trick as connections/invitations.
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const lowered = rows[i]!.map((c) => c.toLowerCase().trim());
    if (lowered.includes("from") && lowered.includes("to") && (lowered.includes("date") || lowered.includes("content"))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx === -1) return empty;

  const header = rows[headerIdx]!.map((h) => h.toLowerCase().trim());
  const data = rows.slice(headerIdx + 1);
  const col = (...candidates: string[]) =>
    candidates.map((c) => header.indexOf(c)).find((i) => i !== -1) ?? -1;

  const iConv = col("conversation id", "conversationid");
  const iFrom = col("from", "sender");
  const iSenderUrl = col("sender profile url", "from profile url", "sender url");
  const iTo = col("to", "recipient", "recipients");
  const iRecipUrls = col("recipient profile urls", "to profile urls", "recipient urls");
  const iDate = col("date", "sent at", "timestamp");
  const iSubject = col("subject");
  const iContent = col("content", "message", "body");

  if (iFrom === -1 || iTo === -1) return empty;

  // Pass 1 — count From frequencies to auto-detect "you".
  const fromCounts = new Map<string, number>();
  for (const r of data) {
    const from = r[iFrom]?.trim();
    if (!from) continue;
    fromCounts.set(from, (fromCounts.get(from) ?? 0) + 1);
  }
  const candidateUserNames = Array.from(fromCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const detectedUserName = overrideUserName?.trim() || candidateUserNames[0]?.name || "";

  if (!detectedUserName) return { ...empty, candidateUserNames };

  // Pass 2 — emit one row per (message × counterpart). Group chats with
  // multiple recipients produce one row per recipient.
  const out: MessageImportRow[] = [];
  for (const r of data) {
    const from = r[iFrom]?.trim() ?? "";
    const to = r[iTo]?.trim() ?? "";
    if (!from || !to) continue;
    const isSent = from === detectedUserName;
    const dateStr = iDate !== -1 ? r[iDate]?.trim() || undefined : undefined;
    const subject = iSubject !== -1 ? r[iSubject]?.trim()?.slice(0, 500) || undefined : undefined;
    const content = iContent !== -1 ? r[iContent]?.trim()?.replace(/\s+/g, " ").slice(0, 200) || undefined : undefined;
    const conversationId = iConv !== -1 ? r[iConv]?.trim() || undefined : undefined;

    if (isSent) {
      // Counterparts = the TO list (semicolon- or comma-separated for
      // group chats).
      const tos = to.split(/[;,]\s*/).filter(Boolean);
      const tosUrls = (iRecipUrls !== -1 ? (r[iRecipUrls] ?? "") : "")
        .split(/[;,]\s*/)
        .map((s) => s.trim());
      tos.forEach((cp, idx) => {
        out.push({
          conversationId,
          counterpartName: cp,
          counterpartLinkedinUrl: tosUrls[idx] || undefined,
          direction: "sent",
          messageDate: dateStr,
          subject,
          contentSnippet: content,
        });
      });
    } else {
      // Counterpart = the sender. Skip if FROM is also the user (self-DMs).
      out.push({
        conversationId,
        counterpartName: from,
        counterpartLinkedinUrl: iSenderUrl !== -1 ? r[iSenderUrl]?.trim() || undefined : undefined,
        direction: "received",
        messageDate: dateStr,
        subject,
        contentSnippet: content,
      });
    }
  }

  return { rows: out, detectedUserName, candidateUserNames };
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
    return parseLinkedInMessages(text, userNameOverride || undefined);
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
      };
      const res = await api.post<{ inserted: number }>("/api/people/bulk", payload);
      onImported?.(res.inserted);
      onFlash(`Imported ${res.inserted.toLocaleString()} ${kind === "invitations" ? "invites" : "connections"}`);
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
