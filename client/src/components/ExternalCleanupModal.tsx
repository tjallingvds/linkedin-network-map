/**
 * ExternalCleanupModal — upload a CSV of contacts already in another CRM
 * (Salesforce / HubSpot / Pipedrive export, etc.) and remove any matches
 * from the user's own CRM boards. Prevents double-touching people who
 * are already in another pipeline.
 *
 * Accepts any CSV that has at least one of: name, email, linkedin, company.
 * Column names are matched case-insensitively and forgivingly — "Full Name",
 * "Email Address", "LinkedIn URL", "Profile URL", etc. all work.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { IconClose, IconUpload, IconCheck } from "../design/icons";

interface ExternalRow {
  name?: string;
  email?: string;
  linkedin?: string;
  company?: string;
}

// ---- CSV parsing — handles quoted fields + escaped quotes. Same as the
// LinkedIn connections importer; kept local so this modal stays standalone.
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

function parseExternalCsv(text: string): ExternalRow[] {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];

  // Find the first row that looks like a header (contains at least one of
  // the expected fields). Salesforce/HubSpot exports often have an intro
  // row or a blank row above the real header.
  const MATCHERS: Array<[keyof ExternalRow, RegExp[]]> = [
    ["name", [/^name$/i, /^full name$/i, /^contact name$/i, /^first name$/i]],
    ["email", [/^email$/i, /^email address$/i, /^work email$/i, /^primary email$/i]],
    ["linkedin", [/^linkedin$/i, /^linkedin url$/i, /^linkedin profile$/i, /^profile url$/i, /^url$/i]],
    ["company", [/^company$/i, /^account$/i, /^organization$/i, /^organisation$/i, /^employer$/i]],
  ];

  let headerIdx = -1;
  let resolved: Partial<Record<keyof ExternalRow, number>> = {};
  let lastName: number | null = null; // for first-name/last-name pair
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const headers = rows[i]!.map((h) => h.trim());
    const hit: Partial<Record<keyof ExternalRow, number>> = {};
    for (const [field, patterns] of MATCHERS) {
      const idx = headers.findIndex((h) => patterns.some((rx) => rx.test(h)));
      if (idx !== -1) hit[field] = idx;
    }
    const lnIdx = headers.findIndex((h) => /^last name$/i.test(h));
    if (Object.keys(hit).length > 0) {
      headerIdx = i;
      resolved = hit;
      lastName = lnIdx !== -1 ? lnIdx : null;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const data = rows.slice(headerIdx + 1);
  const out: ExternalRow[] = [];
  for (const r of data) {
    const row: ExternalRow = {};
    if (resolved.name !== undefined) {
      const first = r[resolved.name]?.trim();
      const last = lastName !== null ? r[lastName]?.trim() : undefined;
      row.name = [first, last].filter(Boolean).join(" ") || undefined;
    }
    if (resolved.email !== undefined) row.email = r[resolved.email]?.trim() || undefined;
    if (resolved.linkedin !== undefined) row.linkedin = r[resolved.linkedin]?.trim() || undefined;
    if (resolved.company !== undefined) row.company = r[resolved.company]?.trim() || undefined;
    // Skip rows that carry no useful identifier at all.
    if (row.name || row.email || row.linkedin) out.push(row);
  }
  return out;
}

export function ExternalCleanupModal({
  onClose, onFlash, onDone,
}: {
  onClose: () => void;
  onFlash: (msg: string) => void;
  /** Called after a successful cleanup. Parent should refresh its board. */
  onDone?: (removed: number, boardsAffected: number) => void;
}) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<"upload" | "confirm">("upload");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (text.trim() ? parseExternalCsv(text) : []), [text]);

  const onPickFile = async (file: File) => {
    const raw = await file.text();
    setText(raw);
  };

  const handleSubmit = async () => {
    if (parsed.length === 0) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ removed: number; boardsAffected: number; scanned: number }>(
        "/api/crm/cleanup-from-external",
        { rows: parsed },
      );
      onFlash(
        res.removed === 0
          ? `Scanned ${res.scanned.toLocaleString()} contacts — no matches found.`
          : `Removed ${res.removed.toLocaleString()} contact${res.removed === 1 ? "" : "s"} across ${res.boardsAffected} board${res.boardsAffected === 1 ? "" : "s"}.`,
      );
      onDone?.(res.removed, res.boardsAffected);
      onClose();
    } catch (err) {
      onFlash(`Cleanup failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

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
              Remove from external CRM
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              Upload a CSV of contacts you already have in another CRM. Any
              matching contacts will be removed from <strong>all your boards</strong>.
              Matched by LinkedIn URL, email, or name+company.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={15} /></button>
        </div>

        {step === "upload" ? (
          <>
            <div className="im-body">
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
                Drop a CSV here, or{" "}
                <button className="tool" onClick={() => fileRef.current?.click()} style={{ fontSize: 12 }}>
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
                <div style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
                  Accepted columns: <code>name</code>, <code>email</code>, <code>linkedin</code>, <code>company</code>.
                </div>
                <div style={{ fontSize: 11, color: "var(--text-mute)", fontFamily: "Geist Mono, monospace" }}>
                  {text.trim() ? `${parsed.length.toLocaleString()} rows parsed` : "empty"}
                </div>
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={onClose}>Cancel</button>
              <button
                className="pill-btn primary"
                disabled={parsed.length === 0}
                onClick={() => setStep("confirm")}
              >
                Next →
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="im-body">
              <div style={{ fontSize: 12.5, color: "var(--text)", marginBottom: 8 }}>
                Ready to scan your boards for matches against{" "}
                <strong>{parsed.length.toLocaleString()}</strong> uploaded contact
                {parsed.length === 1 ? "" : "s"}.
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 12 }}>
                Any contact on one of your own boards that matches an uploaded
                row (by LinkedIn URL, email, or name+company) will be{" "}
                <strong>deleted</strong>. Boards shared with you by other users
                are left alone.
              </div>
              <div className="im-preview">
                <div className="im-prev-head">
                  <span>Name</span><span>Email</span><span>LinkedIn</span><span>Company</span>
                </div>
                {parsed.slice(0, 20).map((p, i) => (
                  <div key={i} className="im-prev-row">
                    <span>{p.name || <em>—</em>}</span>
                    <span>{p.email || <em>—</em>}</span>
                    <span>{p.linkedin || <em>—</em>}</span>
                    <span>{p.company || <em>—</em>}</span>
                  </div>
                ))}
                {parsed.length > 20 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-mute)" }}>
                    + {(parsed.length - 20).toLocaleString()} more…
                  </div>
                )}
              </div>
            </div>
            <div className="im-foot">
              <button className="pill-btn" onClick={() => setStep("upload")}>← Back</button>
              <button className="pill-btn primary" disabled={submitting} onClick={handleSubmit}>
                <IconCheck size={12} />{submitting ? "Removing…" : `Remove matches`}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
