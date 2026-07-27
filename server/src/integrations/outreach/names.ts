/**
 * Deriving a usable first name from the CRM's single `name` column.
 *
 * A naive `split(" ")[0]` produces the exact tells that destroy a personal
 * email — "Hi Dr.," from "Dr. Sarah Chen", "Hi Chen,," from the "Chen, Sarah"
 * CSV order, "Hi MARIA," from a shouty import. Returning `first: null` means
 * "don't mail this person until someone fixes the name".
 */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "professor", "sir", "rev", "mx"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "mba", "cfa", "cpa", "msc", "bsc"]);

/**
 * Derive first/last name from the single `name` column. crm_contacts has no
 * split name fields, and a naive `split(' ')[0]` produces the exact tells that
 * destroy a "handwritten" email: "Hi Dr.," from "Dr. Sarah Chen", "Hi Chen,,"
 * from the "Chen, Sarah" CSV order, "Hi MARIA," from a shouty import.
 *
 * Returns first = null when nothing usable can be derived, so the caller can
 * skip the contact rather than mail a broken greeting.
 */
export function deriveName(raw: string | null | undefined): { first: string | null; last: string | null } {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { first: null, last: null };

  // "Chen, Sarah" → "Sarah Chen" (but leave "Chen, Sarah, PhD"-style suffixes out).
  if (s.includes(",")) {
    const [head, ...tail] = s.split(",").map((p) => p.trim()).filter(Boolean);
    const rest = tail.filter((p) => !SUFFIXES.has(p.toLowerCase().replace(/\./g, "")));
    s = rest.length ? `${rest.join(" ")} ${head}` : head;
  }

  const clean = (w: string) => w.replace(/\./g, "").toLowerCase();
  let parts = s.split(" ").filter(Boolean);
  while (parts.length && TITLES.has(clean(parts[0]))) parts = parts.slice(1);
  while (parts.length && SUFFIXES.has(clean(parts[parts.length - 1]))) parts = parts.slice(0, -1);
  if (!parts.length) return { first: null, last: null };

  // Normalise shouty / all-lowercase imports; leave mixed case (McDonald) alone.
  const fixCase = (w: string) =>
    w === w.toUpperCase() || w === w.toLowerCase()
      ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : w;

  // Nobiliary particles stay lowercase — "van der Berg", not "Van Der Berg".
  const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "ter", "ten", "bin", "ibn", "al"]);
  const first = fixCase(parts[0]);
  const last = parts.length > 1
    ? parts.slice(1).map((w) => (PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : fixCase(w))).join(" ")
    : null;
  // Unusable: initials, punctuation, or anything without two letters.
  if (!/^[\p{L}][\p{L}'’-]+$/u.test(first)) return { first: null, last };
  return { first, last };
}

