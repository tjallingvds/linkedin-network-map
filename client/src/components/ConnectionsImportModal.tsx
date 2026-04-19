/**
 * ConnectionsImportModal — imports a LinkedIn data export into the user's
 * people table. Accepts `Connections.csv` (standard LinkedIn export) and
 * `Invitations.csv` (pending invites). Parses → previews → POST /api/people/
 * bulk. The rows then power "My network" search.
 *
 * LinkedIn's Connections.csv columns:
 *   First Name, Last Name, URL, Email Address, Company, Position, Connected On
 * Invitations.csv columns vary slightly across exports:
 *   From, To, Message, Sent At, Direction
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

type Kind = "connections" | "invitations";

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

  const preview = useMemo(() => {
    if (!text.trim()) return [];
    return parseLinkedIn(text, kind).slice(0, 10_000);
  }, [text, kind]);

  const onPickFile = async (file: File) => {
    const raw = await file.text();
    setText(raw);
    const low = file.name.toLowerCase();
    if (low.includes("invitation")) setKind("invitations");
    else if (low.includes("connection")) setKind("connections");
  };

  const handleImport = async () => {
    setSaving(true);
    try {
      const payload = {
        people: preview.map((p) => ({
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
              Upload <code>Connections.csv</code> or <code>Invitations.csv</code> from your
              LinkedIn data export.
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
              </div>

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
                Drop <strong>{kind === "invitations" ? "Invitations.csv" : "Connections.csv"}</strong> here,
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
                  {text.trim() ? `${preview.length.toLocaleString()} detected` : "empty"}
                </div>
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={onClose}>Cancel</button>
              <button className="pill-btn primary" disabled={!preview.length} onClick={() => setStep("preview")}>
                Preview <IconArrowR size={12} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="im-body">
              <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginBottom: 8 }}>
                Preview — {preview.length.toLocaleString()} {kind === "invitations" ? "invite" : "connection"}
                {preview.length === 1 ? "" : "s"} will be added to your network.
              </div>
              <div className="im-preview">
                <div className="im-prev-head">
                  <span>Name</span><span>Company</span><span>Title</span><span>When</span>
                </div>
                {preview.slice(0, 20).map((p, i) => (
                  <div key={i} className="im-prev-row">
                    <span>{[p.firstName, p.lastName].filter((v) => v && v !== "—").join(" ") || <em>—</em>}</span>
                    <span>{p.company || <em>—</em>}</span>
                    <span>{p.position || <em>—</em>}</span>
                    <span>{p.connectedOn || <em>—</em>}</span>
                  </div>
                ))}
                {preview.length > 20 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-mute)" }}>
                    + {(preview.length - 20).toLocaleString()} more…
                  </div>
                )}
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("paste")}>← Back</button>
              <button className="pill-btn primary" disabled={saving} onClick={handleImport}>
                <IconCheck size={12} />{saving ? "Importing…" : `Import ${preview.length.toLocaleString()}`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
