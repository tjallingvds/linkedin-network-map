/**
 * Deterministic seniority bucketing for LinkedIn job titles.
 * Keyword + suffix matching — no LLM. Buckets are ordered low → high so
 * "VP, Strategy" hits VP, not Director (lookup is highest-match-wins).
 */

export type SeniorityBucket =
  | "c_level"
  | "founder"
  | "partner"
  | "vp"
  | "director"
  | "head"
  | "principal"
  | "lead"
  | "senior_manager"
  | "manager"
  | "senior_ic"
  | "ic"
  | "junior"
  | "intern"
  | "student"
  | "advisor"
  | "unknown";

export const SENIORITY_LABEL: Record<SeniorityBucket, string> = {
  c_level: "C-level",
  founder: "Founder / Owner",
  partner: "Partner",
  vp: "VP",
  director: "Director",
  head: "Head of",
  principal: "Principal",
  lead: "Lead",
  senior_manager: "Senior Manager",
  manager: "Manager",
  senior_ic: "Senior IC",
  ic: "IC",
  junior: "Junior",
  intern: "Intern",
  student: "Student",
  advisor: "Advisor / Board",
  unknown: "Unknown",
};

/** Order from highest seniority to lowest, used for sorting in charts. */
export const SENIORITY_ORDER: SeniorityBucket[] = [
  "founder",
  "c_level",
  "partner",
  "vp",
  "head",
  "director",
  "principal",
  "senior_manager",
  "lead",
  "manager",
  "senior_ic",
  "ic",
  "junior",
  "intern",
  "student",
  "advisor",
  "unknown",
];

/** Match in priority order — highest seniority pattern wins. */
const RULES: { bucket: SeniorityBucket; patterns: RegExp[] }[] = [
  {
    bucket: "founder",
    patterns: [
      /\b(founder|co[- ]?founder|cofounder|owner|proprietor)\b/i,
      /\b(managing\s+director|md)\b/i,
    ],
  },
  {
    bucket: "c_level",
    patterns: [
      /\bchief\s+\w+\s+officer\b/i,
      /\bc[eotfimprsx]o\b/i,
      /\bpresident\b/i,
    ],
  },
  {
    bucket: "partner",
    patterns: [
      /\b(general\s+partner|managing\s+partner|gp|equity\s+partner|partner)\b/i,
    ],
  },
  {
    bucket: "vp",
    patterns: [
      /\b(svp|evp|vp|avp|vice\s+president)\b/i,
    ],
  },
  {
    bucket: "head",
    patterns: [
      /\bhead\s+of\b/i,
      /\bglobal\s+head\b/i,
    ],
  },
  {
    bucket: "director",
    patterns: [
      /\b(director|sr\.?\s+director|senior\s+director)\b/i,
    ],
  },
  {
    bucket: "principal",
    patterns: [
      /\bprincipal\b/i,
      /\bdistinguished\b/i,
      /\bstaff\s+(engineer|scientist|designer)\b/i,
    ],
  },
  {
    bucket: "senior_manager",
    patterns: [
      /\b(senior|sr\.?)\s+manager\b/i,
      /\bgroup\s+manager\b/i,
    ],
  },
  {
    bucket: "lead",
    patterns: [
      /\b(lead|tech\s+lead)\b/i,
    ],
  },
  {
    bucket: "manager",
    patterns: [
      /\bmanager\b/i,
    ],
  },
  {
    bucket: "senior_ic",
    patterns: [
      /\b(sr\.?|senior)\s+(engineer|developer|analyst|consultant|designer|scientist|architect|associate|specialist|recruiter|marketer|writer|editor|advisor|account\s+executive|account\s+manager|product\s+manager|pm)\b/i,
      /\barchitect\b/i,
    ],
  },
  {
    bucket: "advisor",
    patterns: [
      /\b(board\s+member|board\s+director|advisor|advisory\s+board)\b/i,
    ],
  },
  {
    bucket: "junior",
    patterns: [
      /\b(junior|jr\.?|entry[-\s]?level|associate)\b/i,
    ],
  },
  {
    bucket: "intern",
    patterns: [
      /\bintern(ship)?\b/i,
      /\btrainee\b/i,
      /\bgraduate\s+(program|trainee)\b/i,
    ],
  },
  {
    bucket: "student",
    patterns: [
      /\b(student|undergrad|undergraduate|graduate\s+student|phd\s+candidate|mba\s+candidate)\b/i,
    ],
  },
  {
    bucket: "ic",
    patterns: [
      /\b(engineer|developer|analyst|consultant|designer|scientist|account\s+executive|account\s+manager|sales|marketer|recruiter|specialist|writer|editor|product\s+manager|pm|associate)\b/i,
    ],
  },
];

export function classifyTitle(rawTitle: string | null | undefined): SeniorityBucket {
  if (!rawTitle) return "unknown";
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (!title) return "unknown";
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(title))) return rule.bucket;
  }
  return "unknown";
}
