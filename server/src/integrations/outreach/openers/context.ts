/**
 * What we're willing to build an opening line from.
 *
 * The line itself is written from the person's LinkedIn (see research.ts);
 * what's collected here is the CRM's own knowledge, passed alongside so the
 * model can read the profile correctly and avoid contradicting what is
 * already known. It is context, never the subject of the line.
 */
import { db } from "../../../db/index.js";

/**
 * A board's custom columns are keyed by generated ids — `c_linkedin_swbdz`,
 * `c_city_jge3t` — and the values live under those ids on the contact. Handing
 * those to the model as fact names is handing it noise, and showing them as
 * "where this came from" reads like corruption. This maps id → the column's
 * actual label.
 */
export async function columnLabels(boardId: string): Promise<Record<string, string>> {
  const board = await db
    .selectFrom("crm_boards").select("columns").where("id", "=", boardId).executeTakeFirst();
  const cols = Array.isArray(board?.columns) ? board.columns as Array<Record<string, unknown>> : [];
  const out: Record<string, string> = {};
  for (const col of cols) {
    const id = typeof col?.id === "string" ? col.id : "";
    const label = typeof col?.label === "string" ? col.label.trim() : "";
    if (id && label) out[id] = label;
  }
  return out;
}

/** A label the model can read: "Head of AI" → head_of_ai. */
function factKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}

/** Facts we're willing to build a line from, plus where each came from. */
export function contextFor(c: {
  name: string; title: string | null; company: string | null;
  notes: string | null; background: string | null; message_notes: string | null;
  custom_fields: unknown; linkedin: string | null;
}, labels: Record<string, string> = {}): { facts: Record<string, string>; sources: string[] } {
  const facts: Record<string, string> = {};
  const sources: string[] = [];
  const add = (key: string, value: unknown, label: string) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (!v) return;
    facts[key] = v.slice(0, 800);
    sources.push(label);
  };
  add("name", c.name, "name");
  add("job_title", c.title, "title");
  add("company", c.company, "company");
  add("notes", c.notes, "notes");
  add("background", c.background, "background");
  add("previous_conversation_notes", c.message_notes, "message notes");
  for (const [k, v] of Object.entries((c.custom_fields ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) {
      const label = labels[k] ?? k;
      facts[`custom_${factKey(label)}`] = v.trim().slice(0, 500);
      sources.push(label);
    }
  }
  return { facts, sources };
}
