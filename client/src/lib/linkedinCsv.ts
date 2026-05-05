/**
 * Shared parsers for LinkedIn data exports. Used by:
 *  - ConnectionsImportModal (writes to people / message_log)
 *  - SalesAnalysisPage    (writes to sales_analysis_uploads)
 *
 * LinkedIn schemas (vary slightly across exports):
 *   Connections.csv: First Name, Last Name, URL, Email Address, Company,
 *                    Position, Connected On
 *   Invitations.csv: From, To, Message, Sent At, Direction
 *   messages.csv:    CONVERSATION ID, CONVERSATION TITLE, FROM,
 *                    SENDER PROFILE URL, TO, RECIPIENT PROFILE URLS,
 *                    DATE, SUBJECT, CONTENT, FOLDER
 */

export interface NetworkImportRow {
  firstName: string;
  lastName: string;
  company?: string;
  position?: string;
  linkedinUrl?: string;
  email?: string;
  connectedOn?: string;
  category?: string;
}

export interface MessageImportRow {
  conversationId?: string;
  counterpartName: string;
  counterpartLinkedinUrl?: string;
  direction: "sent" | "received";
  messageDate?: string;
  subject?: string;
  contentSnippet?: string;
}

export interface ParsedMessages {
  rows: MessageImportRow[];
  detectedUserName: string;
  candidateUserNames: { name: string; count: number }[];
}

// CSV parsing — handles quoted fields + escaped quotes + CRLF.
export function parseCSV(text: string): string[][] {
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

export function parseLinkedIn(
  text: string,
  kind: "connections" | "invitations",
): NetworkImportRow[] {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];

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

export function parseLinkedInMessages(
  text: string,
  opts: { overrideUserName?: string; maxContentLength?: number } = {},
): ParsedMessages {
  const maxContent = opts.maxContentLength ?? 200;
  const empty: ParsedMessages = { rows: [], detectedUserName: "", candidateUserNames: [] };
  const rows = parseCSV(text);
  if (rows.length === 0) return empty;

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
  const detectedUserName = opts.overrideUserName?.trim() || candidateUserNames[0]?.name || "";

  if (!detectedUserName) return { ...empty, candidateUserNames };

  const out: MessageImportRow[] = [];
  for (const r of data) {
    const from = r[iFrom]?.trim() ?? "";
    const to = r[iTo]?.trim() ?? "";
    if (!from || !to) continue;
    const isSent = from === detectedUserName;
    const dateStr = iDate !== -1 ? r[iDate]?.trim() || undefined : undefined;
    const subject = iSubject !== -1 ? r[iSubject]?.trim()?.slice(0, 500) || undefined : undefined;
    const content = iContent !== -1
      ? r[iContent]?.trim()?.replace(/\s+/g, " ").slice(0, maxContent) || undefined
      : undefined;
    const conversationId = iConv !== -1 ? r[iConv]?.trim() || undefined : undefined;

    if (isSent) {
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
