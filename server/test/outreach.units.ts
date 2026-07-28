/**
 * Pure-logic tests for the outreach engine. No database, no network — safe to
 * run anywhere (env vars are only needed because importing the modules pulls in
 * env.ts, which validates at import time).
 *
 * RUN:
 *   DATABASE_URL="postgres://x@localhost/x" AUTH_SECRET="<32+ chars>" \
 *   npm run test:units --workspace=server
 *
 * Covers the bits where a silent wrong answer is expensive:
 *   - at-rest encryption of the stored Smartlead key (and tamper detection)
 *   - webhook HMAC verification
 *   - provider lead-status -> membership-state mapping
 *   - name derivation (a bad greeting destroys the "handwritten" premise)
 *   - stage classification (a miss here means a sequence never stops)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { encryptSecret, decryptSecret } from "../src/integrations/crypto.ts";
import { mapLeadStatusToState } from "../src/integrations/smartlead.ts";
import { deriveName } from "../src/integrations/outreach/gate.ts";
import { stageStopsSending } from "../src/integrations/outreach/stage-hook.ts";
import { acceptGroup } from "../src/integrations/outreach/openers/sort.ts";
import { parseGroups, describedGroups, blockers } from "../src/integrations/outreach/groups.ts";
import { parseRules, ruleFor } from "../src/integrations/outreach/stage-rules.ts";
import { eventTypeOf } from "../src/integrations/outreach/events.ts";
import { profileKey, isSameProfile, findProfileUrl } from "../src/integrations/outreach/openers/research.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}`); };
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`${good ? "✓" : "✗"} ${name}${good ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("── Secret encryption ──");
const key = "sl_live_ABC123_secret_key_value";
const ct = encryptSecret(key);
ok("ciphertext hides plaintext", ct !== key && !ct.includes(key));
ok("round-trips", decryptSecret(ct) === key);
ok("random IV per encryption", encryptSecret(key) !== encryptSecret(key));
let tampered = false;
try {
  const b = Buffer.from(ct, "base64"); b[b.length - 1] ^= 0xff;
  decryptSecret(b.toString("base64"));
} catch { tampered = true; }
ok("tampered ciphertext rejected (GCM auth)", tampered);

console.log("\n── Webhook HMAC ──");
const verify = (raw: Buffer, sig: string, secret: string) => {
  const exp = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(exp, "utf8"), b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
const secret = "whsec_test";
const body = Buffer.from(JSON.stringify({ event_type: "EMAIL_REPLY", campaign_id: 42 }));
const sig = createHmac("sha256", secret).update(body).digest("hex");
ok("valid signature accepted", verify(body, sig, secret));
ok("wrong secret rejected", !verify(body, sig, "whsec_other"));
ok("tampered body rejected", !verify(Buffer.from(body.toString() + " "), sig, secret));
ok("empty signature rejected", !verify(body, "", secret));

console.log("\n── Lead status mapping ──");
eq("STARTED", mapLeadStatusToState("STARTED"), "active");
eq("INPROGRESS", mapLeadStatusToState("INPROGRESS"), "active");
eq("PAUSED", mapLeadStatusToState("PAUSED"), "paused");
eq("STOPPED", mapLeadStatusToState("STOPPED"), "paused");
eq("BLOCKED", mapLeadStatusToState("BLOCKED"), "blocked");
eq("COMPLETED", mapLeadStatusToState("COMPLETED"), "completed");
eq("unknown -> null (no action)", mapLeadStatusToState("WEIRD"), null);
eq("null -> null", mapLeadStatusToState(null), null);

console.log("\n── Name derivation ──");
const n = (s: string) => { const r = deriveName(s); return [r.first, r.last]; };
eq("plain", n("Sasha Lim"), ["Sasha", "Lim"]);
eq("title stripped", n("Dr. Sarah Chen"), ["Sarah", "Chen"]);
eq("title without dot", n("Prof Alan Turing"), ["Alan", "Turing"]);
eq("'Last, First' reordered", n("Chen, Sarah"), ["Sarah", "Chen"]);
eq("ALL CAPS fixed", n("MARIA GARCIA"), ["Maria", "Garcia"]);
eq("lowercase fixed", n("maria garcia"), ["Maria", "Garcia"]);
eq("particles stay lowercase", n("Jan van der Berg"), ["Jan", "van der Berg"]);
eq("von particle", n("Ludwig von Mises"), ["Ludwig", "von Mises"]);
eq("mononym", n("Madonna"), ["Madonna", null]);
eq("suffix stripped", n("Robert Downey Jr"), ["Robert", "Downey"]);
eq("comma + suffix", n("Sarah Chen, PhD"), ["Sarah", "Chen"]);
eq("mixed case preserved", n("McDonald Smith"), ["McDonald", "Smith"]);
eq("accents preserved", n("José Álvarez"), ["José", "Álvarez"]);
eq("apostrophe preserved", n("O'Brien Kelly"), ["O'Brien", "Kelly"]);
eq("initial is unusable", n("J. Smith"), [null, "Smith"]);
eq("title only is unusable", n("Dr."), [null, null]);
eq("junk is unusable", n("###"), [null, null]);
eq("empty is unusable", n(""), [null, null]);

console.log("\n── Stop-sending stages ──");
const rules = { noSend: ["Replied", "Meeting booked", "Nurture"] };
eq("exact match", stageStopsSending("Replied", rules), true);
eq("case-insensitive", stageStopsSending("replied", rules), true);
eq("punctuation/spacing ignored", stageStopsSending("  Meeting-Booked ", rules), true);
eq("keyword-invisible name still matches", stageStopsSending("Nurture", rules), true);
eq("single-letter typo", stageStopsSending("Repled", rules), true);
eq("typo in a longer name", stageStopsSending("Meting booked", rules), true);
eq("unlisted stage does not stop", stageStopsSending("New", rules), false);
eq("empty stage", stageStopsSending("", rules), false);
eq("no rules configured", stageStopsSending("Replied", { noSend: [] }), false);
eq("null rules", stageStopsSending("Replied", null), false);
// Must not over-match: a genuinely different stage of similar length.
eq("different stage of similar length", stageStopsSending("Rejected", rules), false);

// Contacts store the stage ID; the picker saves the id AND the label, so a
// renamed stage keeps working. Without the id, this silently stops firing.
const renamed = { noSend: ["meeting", "Meeting booked"] };
eq("matches the stored stage id", stageStopsSending("meeting", renamed), true);
eq("matches the label too", stageStopsSending("Meeting booked", renamed), true);
eq("unrelated id does not match", stageStopsSending("new", renamed), false);

// ── Group sorting: what the sorter is allowed to decide ────────────────────
// Being in a group is what makes someone emailable, so a wrong "yes" here
// mails the wrong person. Every uncertain answer must land on null.
console.log("\n— group sorting —");
const defs = parseGroups([
  { id: "a1b2", name: "Bank AI leads", description: "Heads of AI at banks", prompt: "" },
  { id: "c3d4", name: "Undescribed", description: "  ", prompt: "" },
  { id: "e5f6", name: "Insurance ops", description: "Everyone else in insurance", prompt: "" },
]);

eq("accepts a described group", acceptGroup("a1b2", defs), "a1b2");
eq("accepts different casing", acceptGroup("A1B2", defs), "a1b2");
eq("accepts padded", acceptGroup(" e5f6 ", defs), "e5f6");
eq("accepts the group's name", acceptGroup("Insurance ops", defs), "e5f6");
eq("refuses a group with a blank description", acceptGroup("c3d4", defs), null);
eq("refuses that group by name too", acceptGroup("Undescribed", defs), null);
eq("refuses an invented id", acceptGroup("zzzz", defs), null);
eq("refuses a sentence", acceptGroup("probably the bank one", defs), null);
eq("refuses null", acceptGroup(null, defs), null);
eq("refuses a number", acceptGroup(1, defs), null);
eq("refuses everything when nothing is described", acceptGroup("a1b2", []), null);

eq("described groups are counted", describedGroups(defs).length, 2);
eq("whitespace is not a description", describedGroups(parseGroups([{ id: "x", description: "   " }])).length, 0);

// parseGroups is the boundary against whatever is in the jsonb column.
eq("junk is not a group list", parseGroups({ A: "old shape" }), []);
eq("entries without an id are dropped", parseGroups([{ name: "no id" }]), []);
eq("duplicate ids are dropped", parseGroups([{ id: "x" }, { id: "x" }]).length, 1);
eq("a nameless group still gets a label", parseGroups([{ id: "x" }])[0]?.name, "Group 1");

// ── Going live ─────────────────────────────────────────────────────────────
// A group may only send once its opening line is written AND tried on real
// people. `live` stored as true is not enough — the state it claims has to
// still hold, or a hand-edited row could switch sending on.
console.log("\n— going live —");
const mk = (o: Record<string, unknown>) =>
  parseGroups([{ id: "g", name: "G", description: "someone", prompt: "write nicely", ...o }])[0]!;

eq("written, tested and switched on is live", mk({ testedAt: "2026-07-27T10:00:00Z", live: true }).live, true);
eq("not switched on", mk({ testedAt: "2026-07-27T10:00:00Z", live: false }).live, false);
eq("live claimed but never tested", mk({ testedAt: null, live: true }).live, false);
eq("live claimed with no instructions", mk({ prompt: "", testedAt: "2026-07-27T10:00:00Z", live: true }).live, false);
eq("an empty testedAt is not a test", mk({ testedAt: "", live: true }).live, false);
eq("a non-string testedAt is not a test", mk({ testedAt: 12345, live: true }).live, false);

eq("nothing missing when ready",
  blockers(mk({ testedAt: "2026-07-27T10:00:00Z", live: true })), []);
eq("missing the test",
  blockers(mk({ testedAt: null, live: false })), ["instructions not tested yet", "not switched live"]);
eq("missing the instructions",
  blockers(mk({ prompt: "", testedAt: null, live: false })), ["no opening-line instructions", "not switched live"]);
eq("missing the description",
  blockers(mk({ description: "", testedAt: "2026-07-27T10:00:00Z", live: true })),
  ["no description of who belongs"]);

// ── Automatic card moves ───────────────────────────────────────────────────
// These move a human's board without them touching it, so every rule that
// isn't clearly asked for must do nothing.
console.log("\n— card moves —");
const RULES = parseRules({ rules: [
  { when: "sent", from: "new", to: "contacted" },
  { when: "sent", to: "also-contacted" },          // catch-all, lower priority
  { when: "replied", to: "replied-stage" },
  { when: "bounced", from: "contacted", to: "bad-address" },
] });

eq("rules parsed", RULES.length, 4);
eq("a blank from becomes null", RULES[1]?.from, null);

eq("matches on trigger and stage", ruleFor(RULES, "sent", "new")?.to, "contacted");
eq("first match wins", ruleFor(RULES, "sent", "anything")?.to, "also-contacted");
eq("no rule for that trigger", ruleFor(RULES, "unsubscribed", "new"), null);
eq("from must match", ruleFor(RULES, "bounced", "new"), null);
eq("from matching fires", ruleFor(RULES, "bounced", "contacted")?.to, "bad-address");
eq("a card already there is left alone", ruleFor(RULES, "replied", "replied-stage"), null);
eq("null stage still matches a catch-all", ruleFor(RULES, "replied", null)?.to, "replied-stage");

// Anything malformed must be dropped rather than half-applied.
eq("no rules at all", parseRules(null), []);
eq("old shape without rules", parseRules({ noSend: ["Replied"] }), []);
eq("unknown trigger dropped", parseRules({ rules: [{ when: "opened", to: "x" }] }), []);
eq("missing destination dropped", parseRules({ rules: [{ when: "sent", to: "  " }] }), []);
eq("capped at 20", parseRules({ rules: Array.from({ length: 30 }, () => ({ when: "sent", to: "x" })) }).length, 20);

// ── Webhook event names ────────────────────────────────────────────────────
// Smartlead labels these "First Email Sent", "Email Reply", "Email Bounce",
// "Lead Unsubscribed". If a spelling doesn't fold onto the constant we switch
// on, the event is silently ignored: nobody is marked contacted and no card
// moves. Every plausible spelling must land on the same name.
console.log("\n— webhook event names —");
const ev = (v: string) => eventTypeOf({ event_type: v } as never);

eq("Smartlead's own label", ev("First Email Sent"), "FIRST_EMAIL_SENT");
eq("the underscored constant", ev("FIRST_EMAIL_SENT"), "FIRST_EMAIL_SENT");
eq("lower snake case", ev("first_email_sent"), "FIRST_EMAIL_SENT");
eq("hyphenated", ev("first-email-sent"), "FIRST_EMAIL_SENT");
eq("padded and doubled separators", ev("  first  email__sent "), "FIRST_EMAIL_SENT");
eq("Email Reply", ev("Email Reply"), "EMAIL_REPLY");
eq("Email Bounce", ev("Email Bounce"), "EMAIL_BOUNCE");
eq("Lead Unsubscribed", ev("Lead Unsubscribed"), "LEAD_UNSUBSCRIBED");
eq("the `event` key is read too", eventTypeOf({ event: "Email Reply" } as never), "EMAIL_REPLY");
eq("nothing at all", eventTypeOf({} as never), "");

// ── Whose LinkedIn we read ─────────────────────────────────────────────────
// Only the profile stored on the contact. A line written from a different
// person with the same name reads as confident and is entirely false, so the
// match has to be exact — while still tolerating how URLs get pasted.
console.log("\n— linkedin matching —");
const WANT = "in/sasha-lim-1a2b3";

eq("plain profile url", profileKey("https://www.linkedin.com/in/sasha-lim-1a2b3"), WANT);
eq("trailing slash", profileKey("https://www.linkedin.com/in/sasha-lim-1a2b3/"), WANT);
eq("tracking query", profileKey("https://www.linkedin.com/in/sasha-lim-1a2b3?trk=abc"), WANT);
eq("country subdomain", profileKey("https://nl.linkedin.com/in/Sasha-Lim-1a2b3"), WANT);
eq("no protocol", profileKey("linkedin.com/in/sasha-lim-1a2b3"), WANT);
eq("bare path", profileKey("/in/sasha-lim-1a2b3"), WANT);
eq("deep link to a subpage", profileKey("https://linkedin.com/in/sasha-lim-1a2b3/details/experience"), WANT);
eq("company pages keep their prefix", profileKey("https://linkedin.com/company/acme"), "company/acme");

eq("empty", profileKey(""), null);
eq("null", profileKey(null), null);
eq("a website that isn't linkedin", profileKey("https://acme.com/team/sasha"), null);
eq("a linkedin feed url is not a profile", profileKey("https://linkedin.com/feed/update/123"), null);
eq("the bare domain is not a profile", profileKey("https://linkedin.com/"), null);
eq("a slugless profile url", profileKey("https://linkedin.com/in/"), null);

// The filter that keeps someone else's profile out of the facts.
eq("same profile accepted", isSameProfile("https://www.linkedin.com/in/sasha-lim-1a2b3/", WANT), true);
eq("a different person is rejected", isSameProfile("https://www.linkedin.com/in/sasha-lim-9z9z9", WANT), false);
eq("a similar slug is rejected", isSameProfile("https://linkedin.com/in/sasha-lim", WANT), false);
eq("a non-profile result is rejected", isSameProfile("https://linkedin.com/pulse/some-article", WANT), false);
eq("a missing url is rejected", isSameProfile(undefined, WANT), false);

// Where the profile actually lives. Reading only the built-in column told
// people with an obvious LinkedIn link that they had none.
console.log("\n— finding the profile on a contact —");
const PROF = "https://www.linkedin.com/in/alisha-lehr-1a2b3";

eq("the built-in column", findProfileUrl({ linkedin: PROF }), PROF);
eq("a custom field named for it",
  findProfileUrl({ linkedin: null, custom_fields: { "LinkedIn URL": PROF } }), PROF);
eq("a custom field named anything",
  findProfileUrl({ linkedin: null, custom_fields: { Source: PROF } }), PROF);
eq("the named field wins over a stray one",
  findProfileUrl({ linkedin: null, custom_fields: { Website: "https://linkedin.com/in/someone-else", linkedin: PROF } }),
  PROF);
eq("the built-in column wins over a custom one",
  findProfileUrl({ linkedin: PROF, custom_fields: { li_url: "https://linkedin.com/in/other" } }), PROF);
eq("a company page counts as a profile URL",
  findProfileUrl({ linkedin: null, custom_fields: { x: "https://linkedin.com/company/acme" } }),
  "https://linkedin.com/company/acme");

eq("nothing anywhere", findProfileUrl({ linkedin: null }), null);
eq("blank column", findProfileUrl({ linkedin: "   " }), null);
eq("non-LinkedIn values are ignored",
  findProfileUrl({ linkedin: null, custom_fields: { site: "https://acme.com", note: "call him" } }), null);
eq("non-string custom values don't throw",
  findProfileUrl({ linkedin: null, custom_fields: { n: 42, b: true, o: { x: 1 } } }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
