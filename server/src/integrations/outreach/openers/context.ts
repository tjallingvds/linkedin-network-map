/**
 * What we're willing to build an opening line from.
 *
 * The line itself is written from the person's LinkedIn (see research.ts);
 * what's collected here is the CRM's own knowledge, passed alongside so the
 * model can read the profile correctly and avoid contradicting what is
 * already known. It is context, never the subject of the line.
 */
/** Facts we're willing to build a line from, plus where each came from. */
export function contextFor(c: {
  name: string; title: string | null; company: string | null;
  notes: string | null; background: string | null; message_notes: string | null;
  custom_fields: unknown; linkedin: string | null;
}): { facts: Record<string, string>; sources: string[] } {
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
      facts[`custom_${k}`] = v.trim().slice(0, 500);
      sources.push(k);
    }
  }
  return { facts, sources };
}
