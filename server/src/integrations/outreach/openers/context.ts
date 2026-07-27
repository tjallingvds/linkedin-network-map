/**
 * What we're willing to build an opening line from, and whether it's enough.
 *
 * Title + company alone is NOT enough — "I saw you're CTO at Acme" reads as a
 * mail-merge, which is the exact failure this feature exists to avoid. We
 * require at least one substantive free-text fact or a real web finding.
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

/**
 * Is there enough here to say something specific? Title + company alone is
 * generic ("I saw you're CTO at Acme" is not personal), so we require at least
 * one substantive free-text fact.
 */
export function hasRealMaterial(facts: Record<string, string>): boolean {
  const substantive = ["notes", "background", "previous_conversation_notes"];
  if (substantive.some((k) => (facts[k]?.length ?? 0) >= 25)) return true;
  if (Object.keys(facts).some((k) => k.startsWith("web_"))) return true;
  return Object.keys(facts).some((k) => k.startsWith("custom_") && facts[k]!.length >= 15);
}

