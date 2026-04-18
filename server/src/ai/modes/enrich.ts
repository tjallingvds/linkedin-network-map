/**
 * Enrich mode — Apollo.io-powered.
 *
 * Flow:
 *   1. AI parses the input (names / emails / domains / LinkedIn URLs) into
 *      identity objects.
 *   2. For each, call Apollo.io `/people/match` to pull a verified profile.
 *   3. Map Apollo's response to our Prospect shape.
 *
 * If no AI key is set we fall back to a lightweight regex-based parser so a
 * minimally-configured server still works with just APOLLO_API_KEY.
 */
import type { AiProvider, CompletionResult, Prospect } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import { apolloMatchPerson, apolloConfigured, type ApolloPerson } from "../../integrations/apollo.js";
import type { UserKeys } from "../user-keys.js";

interface Subject {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  domain?: string;
  organizationName?: string;
  linkedinUrl?: string;
}

export async function runEnrich(
  provider: AiProvider,
  userInput: string,
  userId: string,
  userKeys?: UserKeys,
): Promise<CompletionResult> {
  if (!apolloConfigured(userKeys)) {
    throw new Error("Apollo key missing — add it in Settings → API keys to enable enrichment.");
  }

  // 1. Parse input into identity subjects.
  const subjects = await parseSubjects(provider, userInput, userId, userKeys);
  if (subjects.length === 0) {
    return {
      kind: "text",
      content: "Couldn't identify any people in that input. Paste names, emails, domains, or LinkedIn URLs.",
    };
  }

  // 2. Call Apollo in parallel (cap at 8 to be polite to the API).
  const matches = await Promise.all(
    subjects.slice(0, 8).map(async (s) => {
      try {
        return await apolloMatchPerson({ ...s, userId, userKeys });
      } catch (err) {
        console.warn("apollo match failed for", s, err);
        return null;
      }
    }),
  );

  // 3. Map to Prospect shape.
  const prospects: Prospect[] = matches
    .filter((m): m is ApolloPerson => !!m)
    .map((m, i) => apolloToProspect(m, i));

  const missed = matches.filter((m) => !m).length;
  const summary =
    prospects.length === 0
      ? `Apollo didn't return matches for your ${subjects.length} subject${subjects.length === 1 ? "" : "s"}. Try more specific input (email + name, or name + company).`
      : `Enriched <strong>${prospects.length}</strong> of ${subjects.length} via Apollo.io.` +
        (missed > 0 ? ` <span class="pill-inline">${missed} no match</span>` : "");

  return { kind: "prospects", summary, prospects };
}

async function parseSubjects(
  provider: AiProvider, userInput: string, userId: string, userKeys?: UserKeys,
): Promise<Subject[]> {
  const hasAi =
    provider === "openai" ? !!(userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? !!(userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    !!(userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);

  if (hasAi) {
    const parsed = await aiJson<{ subjects: Subject[] }>(
      provider,
      "You parse pasted text into identity objects for people lookup (Apollo.io match format).",
      `Input:\n${userInput}\n\nReturn {"subjects": [...]} where each subject has whatever identifiers you can extract: {firstName?, lastName?, name?, email?, domain?, organizationName?, linkedinUrl?}. Max 8 subjects. Include only what you can infer — don't guess.`,
      { maxTokens: 700, userId, userKeys },
    );
    return parsed.subjects ?? [];
  }

  // Fallback: parse common forms with regex.
  return fallbackParse(userInput);
}

/** Minimal regex parser for emails, LinkedIn URLs, and "First Last" names. */
function fallbackParse(text: string): Subject[] {
  const subjects: Subject[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean)) {
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());

    // LinkedIn URL
    const li = line.match(/https?:\/\/(www\.)?linkedin\.com\/in\/[^\s]+/i);
    if (li) { subjects.push({ linkedinUrl: li[0] }); continue; }

    // Email
    const em = line.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) {
      const [local, domain] = em[0].split("@");
      const nameParts = (local ?? "").split(/[._-]/).filter(Boolean);
      subjects.push({
        email: em[0],
        domain,
        firstName: nameParts[0],
        lastName: nameParts[1],
      });
      continue;
    }

    // Name + optional company ("Maya Okafor at Lumen AI")
    const at = line.split(/\s+(?:at|@)\s+/i);
    const nameStr = at[0]?.trim();
    const org = at[1]?.trim();
    const parts = nameStr?.split(/\s+/).filter(Boolean) ?? [];
    if (parts.length >= 2) {
      subjects.push({
        firstName: parts[0],
        lastName: parts.slice(1).join(" "),
        organizationName: org,
      });
    }
  }
  return subjects.slice(0, 8);
}

/** Shape Apollo's response into our Prospect. */
function apolloToProspect(p: ApolloPerson, i: number): Prospect {
  const phone = p.phone_numbers?.[0]?.sanitized_number ?? p.phone_numbers?.[0]?.raw_number ?? null;
  const loc = [p.city, p.state, p.country].filter(Boolean).join(", ") || undefined;
  const org = p.organization;

  const signals: Prospect["signals"] = [];
  if (p.email && p.email_status === "verified") {
    signals.push({ kind: "match", text: `Verified email via Apollo`, when: "" });
  }
  if (org?.latest_funding_round_date) {
    const d = new Date(org.latest_funding_round_date);
    const days = Math.round((Date.now() - d.getTime()) / 86400000);
    if (days < 365) {
      signals.push({
        kind: "hot",
        text: `${org.name ?? "Company"} raised ${org.total_funding ? `$${formatMoney(org.total_funding)} ` : ""}recently`,
        when: `${days} days ago`,
      });
    }
  }

  const past: Prospect["past"] = (p.employment_history ?? [])
    .filter((e) => e.organization_name && e.organization_name !== org?.name)
    .slice(0, 3)
    .map((e) => ({
      co: e.organization_name ?? "",
      role: e.title ?? "",
      when: [e.start_date?.slice(0, 4), e.end_date?.slice(0, 4) ?? "present"].filter(Boolean).join("–"),
    }));

  return {
    id: p.id ?? `apollo-${i}-${Date.now()}`,
    name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown"),
    title: p.title ?? "",
    company: org?.name ?? "",
    loc,
    email: p.email ?? undefined,
    emailConf: p.email_status === "verified" ? 95 : p.email ? 70 : undefined,
    phone,
    linkedin: p.linkedin_url,
    headcount: org?.estimated_num_employees ? `${org.estimated_num_employees} ppl` : undefined,
    funding: org?.total_funding ? `$${formatMoney(org.total_funding)}` : undefined,
    signals,
    past,
    matchPct: p.email_status === "verified" ? 95 : 85,
  };
}

function formatMoney(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
