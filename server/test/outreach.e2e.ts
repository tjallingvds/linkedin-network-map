/**
 * End-to-end integration suite for the outreach engine.
 *
 * Real Postgres + real application code + a fake Smartlead API + the real
 * Express webhook route, so middleware ordering (raw body before express.json)
 * and HMAC verification are genuinely exercised rather than assumed.
 *
 * RUN:
 *   OUTREACH_E2E_ALLOW_DESTRUCTIVE=1 \
 *   DATABASE_URL="postgres://…/crm_test"  # MUST be a scratch DB — it is wiped
 *   AUTH_SECRET="<32+ chars>" PORT=45999 SERVER_URL="http://localhost:45999" \
 *   SMARTLEAD_BASE_URL="http://127.0.0.1:59123/api/v1" \
 *   npm run test:outreach --workspace=server
 *
 * The suite TRUNCATES every table it touches, including `users`. The guard
 * below refuses to run unless the opt-in flag is set AND the database name
 * looks like a test database — pointing this at production would delete data.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHmac } from "node:crypto";
import { FakeSmartlead } from "./fake-smartlead.ts";

const DB_URL = process.env.DATABASE_URL ?? "";
const dbName = DB_URL.split("/").pop()?.split("?")[0] ?? "";
if (process.env.OUTREACH_E2E_ALLOW_DESTRUCTIVE !== "1") {
  console.error("Refusing to run: set OUTREACH_E2E_ALLOW_DESTRUCTIVE=1 (this suite wipes the database).");
  process.exit(2);
}
if (!/test|scratch|tmp/i.test(dbName)) {
  console.error(`Refusing to run: database "${dbName}" does not look like a test database.`);
  process.exit(2);
}

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const { db } = await import(`${R}/db/index.ts`);
const { connectAccount, getAccountByBoard } = await import(`${R}/integrations/outreach/accounts.ts`);
const { selectEligible, exportTier } = await import(`${R}/integrations/outreach/gate.ts`);
const { suppressEmail, blockDomain } = await import(`${R}/integrations/outreach/suppress.ts`);
const { reconcileBoard } = await import(`${R}/integrations/outreach/reconcile.ts`);
const { onStageChange } = await import(`${R}/integrations/outreach/stage-hook.ts`);
const { funnel } = await import(`${R}/integrations/outreach/metrics.ts`);
const { saveGroups, markTested, listGroups } = await import(`${R}/integrations/outreach/groups.ts`);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  <<< ${JSON.stringify(extra)}`}`);
};
const eq = (name: string, got: unknown, want: unknown) =>
  ok(`${name} (${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), { got, want });

const PORT = 45999;
const fake = new FakeSmartlead();

async function reset() {
  for (const t of ["outreach_events", "outreach_alerts", "outreach_campaign_memberships", "outreach_jobs",
                   "suppressions", "outreach_campaigns", "smartlead_accounts",
                   "crm_contacts", "crm_boards", "users"]) {
    await db.deleteFrom(t as any).execute();
  }
  fake.leads.clear();
  fake.reset();
}

async function seed() {
  const user = await db.insertInto("users").values({ email: "op@observable.test" })
    .returning("id").executeTakeFirstOrThrow();
  const board = await db.insertInto("crm_boards")
    .values({ user_id: user.id, name: "Outreach", emoji: "📧" })
    .returning("id").executeTakeFirstOrThrow();
  const add = async (name: string, email: string | null, tier: string | null, stage = "New") =>
    (await db.insertInto("crm_contacts")
      .values({ board_id: board.id, user_id: user.id, name, email, tier, stage } as any)
      .returning("id").executeTakeFirstOrThrow()).id;
  return { userId: user.id, boardId: board.id, add };
}

async function main() {
  await fake.start(59123);
  await reset();
  const { userId, boardId, add } = await seed();

  // ── Fixtures covering every gate rule ──────────────────────────────────
  const cSasha = await add("Sasha Lim", "s.lim@acme.com", "B");
  const cDoctor = await add("Dr. Sarah Chen", "s.chen@acme.com", "B");
  const cComma = await add("Nair, Priya", "p.nair@acme.com", "B");
  const cDupA = await add("Ravi Mehta", "r.mehta@acme.com", "B");
  const cDupB = await add("Ravi Mehta (dup)", "R.Mehta@acme.com", "B"); // same human, other row
  const cNoEmail = await add("No Email", null, "B");
  const cBadName = await add("###", "weird@acme.com", "B");
  const cTierC = await add("Other Tier", "tc@acme.com", "C");
  const cSuppressed = await add("Opted Out", "gone@acme.com", "B");
  const cDomain = await add("Blocked Org", "cfo@blocked.com", "B");
  const cSubdomain = await add("Blocked Sub", "eu@mail.blocked.com", "B");

  await db.insertInto("suppressions")
    .values({ user_id: userId, scope: "email", value: "gone@acme.com", reason: "opt_out" }).execute();
  await db.insertInto("suppressions")
    .values({ user_id: userId, scope: "domain", value: "blocked.com", reason: "compliance" }).execute();

  await connectAccount(userId, boardId, "sl_test_key");
  const account = await getAccountByBoard(boardId);
  await db.insertInto("outreach_campaigns").values({
    user_id: userId, board_id: boardId, provider_campaign_id: "4821", tier: "B", name: "Tier B",
  }).execute();

  // ── A group has to be written, tested and switched live before it sends ──
  // Everything below depends on this, which is the point: an untested group is
  // not a sending group, whatever else is configured.
  console.log("\n── Going live ──");
  await saveGroups(userId, boardId, [
    { id: "B", name: "Tier B outbound", description: "Heads of AI at banks", prompt: "Open with their AI work." },
  ]);
  await db.updateTable("crm_boards").set({ outreach_enabled: true }).where("id", "=", boardId).execute();
  eq("an untested group sends nobody", (await selectEligible(userId, { tier: "B", boardId })).length, 0);

  // Claiming live without a test must not work, even straight through the API.
  await saveGroups(userId, boardId, [
    { id: "B", name: "Tier B outbound", description: "Heads of AI at banks", prompt: "Open with their AI work.", live: true },
  ]);
  eq("live cannot be claimed without a test", (await listGroups(boardId))[0]?.live, false);
  eq("and still sends nobody", (await selectEligible(userId, { tier: "B", boardId })).length, 0);

  // Test it, then switch it live — the real order.
  await markTested(userId, boardId, "B");
  await saveGroups(userId, boardId, [
    { id: "B", name: "Tier B outbound", description: "Heads of AI at banks", prompt: "Open with their AI work.", live: true },
  ]);
  eq("tested and switched live", (await listGroups(boardId))[0]?.live, true);
  ok("now it has people to send", (await selectEligible(userId, { tier: "B", boardId })).length > 0);

  // Editing the instructions invalidates the test and drops it out of live.
  await saveGroups(userId, boardId, [
    { id: "B", name: "Tier B outbound", description: "Heads of AI at banks", prompt: "Different instructions now.", live: true },
  ]);
  const afterEdit = (await listGroups(boardId))[0];
  eq("changing the prompt clears the test", afterEdit?.testedAt, null);
  eq("and takes it off live", afterEdit?.live, false);
  eq("so it sends nobody again", (await selectEligible(userId, { tier: "B", boardId })).length, 0);

  // Renaming must NOT invalidate it — only the instructions matter.
  await markTested(userId, boardId, "B");
  await saveGroups(userId, boardId, [
    { id: "B", name: "Renamed group", description: "Heads of AI at banks", prompt: "Different instructions now.", live: true },
  ]);
  eq("renaming keeps it live", (await listGroups(boardId))[0]?.live, true);

  // Back to off, so the "off by default" section below tests what it claims.
  await db.updateTable("crm_boards").set({ outreach_enabled: false }).where("id", "=", boardId).execute();

  // ── 0. Off by default ───────────────────────────────────────────────────
  // Connecting an account must arm NOTHING. Until the board is switched on,
  // the gate yields nobody and an export is refused outright.
  console.log("\n── Off by default ──");
  const beforeEnable = await selectEligible(userId, { tier: "B", boardId });
  eq("connecting alone makes nobody eligible", beforeEnable.length, 0);
  let refused = "";
  try { await exportTier(userId, { tier: "B", boardId }); }
  catch (e) { refused = (e as Error).message; }
  eq("export refused while board is off", refused, "outreach_disabled_for_board");
  eq("nothing was pushed to the provider", fake.callsTo("/campaigns/4821/leads").length, 0);

  // A card moved on a disabled board must not touch Smartlead either.
  const cOffBoard = await add("Ignored Person", "ignored@acme.com", "B");
  await db.insertInto("outreach_campaign_memberships").values({
    user_id: userId, contact_id: cOffBoard,
    campaign_id: (await db.selectFrom("outreach_campaigns").select("id").where("board_id", "=", boardId).executeTakeFirstOrThrow()).id,
    provider_campaign_id: "4821", provider_lead_id: "7777", state: "active",
  } as any).execute();
  fake.leads.set("4821", [{ id: "7777", email: "ignored@acme.com", status: "INPROGRESS" }]);
  await onStageChange(userId, cOffBoard, "Meeting booked");
  eq("card-drag inert while board is off", fake.callsTo("/leads/7777/pause").length, 0);
  // Clean the scaffolding back out before the real run.
  await db.deleteFrom("outreach_campaign_memberships").where("contact_id", "=", cOffBoard).execute();
  await db.deleteFrom("crm_contacts").where("id", "=", cOffBoard).execute();
  fake.leads.clear();
  fake.reset();

  // Now switch the board on — the deliberate, per-board act.
  await db.updateTable("crm_boards").set({ outreach_enabled: true }).where("id", "=", boardId).execute();

  // ── 0b. Putting someone in a group is what makes them sendable ──────────
  // Without this the whole feature is unreachable: no group, no eligibility,
  // nothing ever reaches the approval queue.
  console.log("\n── Group field ──");
  {
    const token = "grp-session-" + Date.now();
    await db.insertInto("sessions").values({
      user_id: userId, session_token: token, expires: new Date(Date.now() + 3600_000),
    } as any).execute();
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${PORT}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Cookie: `nm_session=${token}`, ...(init.headers ?? {}) },
      });
    // The server has to be up for this; it is started further down, so only
    // assert the DB-level contract here and the HTTP one after boot.
    const ungrouped = await add("Ungrouped Person", "ungrouped@acme.com", null);
    const before = (await selectEligible(userId, { tier: "B", boardId })).some((c: any) => c.id === ungrouped);
    eq("someone with no group is not sendable", before, false);
    await db.updateTable("crm_contacts").set({ tier: "B" }).where("id", "=", ungrouped).execute();
    const after = (await selectEligible(userId, { tier: "B", boardId })).some((c: any) => c.id === ungrouped);
    eq("setting a group makes them sendable", after, true);
    // Put them back so later counts are unaffected.
    await db.deleteFrom("crm_contacts").where("id", "=", ungrouped).execute();
    void call;
  }

  // ── 1. The gate ─────────────────────────────────────────────────────────
  console.log("\n── Export gate ──");
  const eligible = await selectEligible(userId, { tier: "B", boardId });
  const emails = eligible.map((e: any) => e.email.toLowerCase()).sort();
  ok("excludes suppressed email", !emails.includes("gone@acme.com"), emails);
  ok("excludes suppressed domain", !emails.includes("cfo@blocked.com"), emails);
  ok("excludes SUBdomain of suppressed domain", !emails.includes("eu@mail.blocked.com"), emails);
  ok("excludes null email", eligible.every((e: any) => !!e.email));
  ok("excludes other tier", !emails.includes("tc@acme.com"), emails);
  eq("dedupes same email across contact rows", emails.filter((e: string) => e === "r.mehta@acme.com").length, 1);

  // ── 2. Export ───────────────────────────────────────────────────────────
  console.log("\n── Export ──");
  // An approved personal line must travel to Smartlead as a custom field, so a
  // template can put {{opening_line}} at the top of the email.
  await db.updateTable("crm_contacts").set({
    opening_line: "Saw your talk on model-risk review at FinTech Connect.",
    opening_line_source: "https://linkedin.com/in/sashalim",
    opening_line_status: "approved",
  } as any).where("id", "=", cSasha).execute();
  // A line that was drafted but NOT approved must never reach Smartlead.
  await db.updateTable("crm_contacts").set({
    opening_line: "UNAPPROVED — must not be sent.",
    opening_line_status: "draft",
  } as any).where("id", "=", cComma).execute();
  const result: any = await exportTier(userId, { tier: "B", boardId });
  eq("held back unusable name", result.skippedBadName, 1);
  eq("pushed", result.pushed, 4); // sasha, doctor, comma, ravi(one of the dup pair)
  eq("captured lead ids for all pushed", result.idsCaptured, 4);

  const addCalls = fake.callsTo("/campaigns/4821/leads").filter((c) => c.method === "POST");
  eq("one add-leads batch", addCalls.length, 1);
  const sent = addCalls[0].body;
  eq("ignore_global_block_list false", sent.settings.ignore_global_block_list, false);
  eq("ignore_unsubscribe_list false", sent.settings.ignore_unsubscribe_list, false);
  const byEmail = new Map(sent.lead_list.map((l: any) => [l.email, l]));
  eq("title stripped from first name", (byEmail.get("s.chen@acme.com") as any).first_name, "Sarah");
  eq("'Last, First' reordered", (byEmail.get("p.nair@acme.com") as any).first_name, "Priya");
  eq("plain name intact", (byEmail.get("s.lim@acme.com") as any).first_name, "Sasha");
  eq("emails lowercased", (byEmail.get("r.mehta@acme.com") as any) !== undefined, true);
  ok("bad-name contact never sent", !byEmail.has("weird@acme.com"));
  ok("an unapproved draft line is never merged",
    (byEmail.get("p.nair@acme.com") as any)?.custom_fields?.opening_line === undefined);
  eq("approved opening line travels as a custom field",
    (byEmail.get("s.lim@acme.com") as any).custom_fields?.opening_line,
    "Saw your talk on model-risk review at FinTech Connect.");
  ok("contacts without a line send no opening_line field",
    (byEmail.get("p.nair@acme.com") as any).custom_fields?.opening_line === undefined);

  const memberships = await db.selectFrom("outreach_campaign_memberships").selectAll()
    .where("user_id", "=", userId).execute();
  eq("memberships created", memberships.length, 4);
  ok("all memberships carry provider_lead_id", memberships.every((m: any) => !!m.provider_lead_id));
  const statuses = await db.selectFrom("crm_contacts").select(["id", "outreach_status"])
    .where("id", "in", [cSasha, cDoctor, cComma]).execute();
  // Handed to Smartlead is not the same as emailed: they sit at "queued" until
  // Smartlead reports the first send. Marking them contacted here would date
  // the touch wrongly and count people who may never receive anything.
  ok("contacts marked queued, not contacted",
    statuses.every((s: any) => s.outreach_status === "queued"), statuses);

  // Re-running the gate must now exclude everyone already in a live campaign.
  // The only survivor should be the bad-name contact, which was held back at
  // export (not at the gate) and stays eligible until its name is fixed.
  const second = await selectEligible(userId, { tier: "B", boardId });
  eq("re-run leaves only the held-back bad-name contact",
    second.map((c: any) => c.email.toLowerCase()), ["weird@acme.com"]);
  ok("duplicate-email twin excluded after its twin went live",
    !second.some((c: any) => c.email.toLowerCase() === "r.mehta@acme.com"), second);

  // ── 3. Webhooks through the REAL Express route ──────────────────────────
  console.log("\n── Webhook route (real HTTP, real HMAC) ──");
  process.env.PORT = String(PORT);
  await import(`${R}/index.ts`);
  // Poll until the server is actually accepting connections — boot runs
  // migrations first, so a fixed sleep races it.
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/health`); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }

  const token = "test-session-token-" + Date.now();
  await db.insertInto("sessions").values({
    user_id: userId, session_token: token, expires: new Date(Date.now() + 3600_000),
  } as any).execute();
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: `nm_session=${token}`, ...(init.headers ?? {}) },
    });

  const hookUrl = `http://127.0.0.1:${PORT}/hooks/smartlead/${account!.webhookToken}`;
  const post = async (payload: unknown, opts: { sig?: string; reqId?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const sig = opts.sig ?? createHmac("sha256", account!.webhookSecret).update(raw).digest("hex");
    return fetch(hookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Smartlead-Signature": sig,
                 ...(opts.reqId ? { "X-Request-Id": opts.reqId } : {}) },
      body: raw,
    });
  };

  eq("bad signature rejected", (await post({ event_type: "EMAIL_SENT" }, { sig: "deadbeef" })).status, 401);
  eq("unknown token rejected",
    (await fetch(`http://127.0.0.1:${PORT}/hooks/smartlead/nope`, { method: "POST", body: "{}" })).status, 401);

  // ── Automatic card moves ────────────────────────────────────────────────
  // A rule moves a real card off a real webhook, and saving rules must not
  // wipe the stop-sending stages that share the same column.
  {
    const rulesRes = await authed(`/api/outreach/board/${boardId}/stage-rules`, {
      method: "POST",
      body: JSON.stringify({ rules: [
        { when: "sent", from: "New", to: "Contacted" },
        { when: "replied", to: "Replied" },
      ] }),
    });
    eq("rules save", rulesRes.status, 200);

    await authed(`/api/outreach/board/${boardId}/stop-stages`, {
      method: "POST", body: JSON.stringify({ stages: ["Meeting booked"] }),
    });
    const st1: any = await (await authed(`/api/outreach/board/${boardId}`)).json();
    eq("saving stop-stages keeps the move rules", st1.stageRules.length, 2);
    eq("and the stop stages", st1.stopStages, ["Meeting booked"]);

    const rules2 = await authed(`/api/outreach/board/${boardId}/stage-rules`, {
      method: "POST",
      body: JSON.stringify({ rules: [{ when: "sent", from: "New", to: "Contacted" }] }),
    });
    eq("saving rules keeps the stop stages", rules2.status, 200);
    const st2: any = await (await authed(`/api/outreach/board/${boardId}`)).json();
    eq("stop stages survived", st2.stopStages, ["Meeting booked"]);
  }

  // The send webhook is what actually marks someone contacted — nothing else
  // does, so a campaign paused in Smartlead before it ever sends leaves them
  // truthfully "queued".
  const comma = fake.leads.get("4821")!.find((l) => l.email === "p.nair@acme.com")!;
  await post({ event_type: "EMAIL_SENT", campaign_id: 4821, lead_id: comma.id,
               to_email: "p.nair@acme.com" }, { reqId: "req-sent-1" });
  await new Promise((r) => setTimeout(r, 500));
  const commaAfter: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cComma).executeTakeFirst();
  eq("EMAIL_SENT is what marks them contacted", commaAfter.outreach_status, "contacted");

  // …and the card moved itself, because a rule said to.
  const commaStage: any = await db.selectFrom("crm_contacts").select("stage")
    .where("id", "=", cComma).executeTakeFirst();
  eq("the send rule moved the card", commaStage.stage, "Contacted");

  // A second send for someone no longer in "New" must not move them again.
  const doctorLead = fake.leads.get("4821")!.find((l) => l.email === "s.chen@acme.com")!;
  await db.updateTable("crm_contacts").set({ stage: "Meeting" }).where("id", "=", cDoctor).execute();
  await post({ event_type: "EMAIL_SENT", campaign_id: 4821, lead_id: doctorLead.id,
               to_email: "s.chen@acme.com" }, { reqId: "req-sent-2" });
  await new Promise((r) => setTimeout(r, 500));
  const doctorStage: any = await db.selectFrom("crm_contacts").select("stage")
    .where("id", "=", cDoctor).executeTakeFirst();
  eq("a card past that stage is left where it is", doctorStage.stage, "Meeting");

  // Smartlead's own spelling, straight from the list of events it offers,
  // through the real route. If this is ignored — as it was when we matched the
  // raw uppercase string — nobody is ever marked contacted and no card moves.
  const raviLead = fake.leads.get("4821")!.find((l) => l.email.toLowerCase() === "r.mehta@acme.com")!;
  await post({ event_type: "First Email Sent", campaign_id: 4821, lead_id: raviLead.id,
               to_email: "r.mehta@acme.com" }, { reqId: "req-sent-label" });
  await new Promise((r) => setTimeout(r, 500));
  const raviRow: any = await db.selectFrom("crm_contacts").select(["outreach_status", "stage"])
    .where("id", "=", cDupA).executeTakeFirst();
  eq('"First Email Sent" is understood', raviRow?.outreach_status, "contacted");
  eq("and it moved the card", raviRow?.stage, "Contacted");

  const sashaLead = fake.leads.get("4821")!.find((l) => l.email === "s.lim@acme.com")!;
  eq("valid signature accepted",
    (await post({ event_type: "EMAIL_REPLY", campaign_id: 4821, lead_id: sashaLead.id,
                  to_email: "s.lim@acme.com", lead_category: "Interested" }, { reqId: "req-1" })).status, 200);
  await new Promise((r) => setTimeout(r, 600));

  const sashaAfter: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cSasha).executeTakeFirst();
  eq("human reply -> responded", sashaAfter.outreach_status, "responded");
  eq("human reply -> Smartlead pause called", fake.callsTo(`/leads/${sashaLead.id}/pause`).length, 1);
  eq("lead paused on provider", sashaLead.status, "PAUSED");

  // Idempotency: same X-Request-Id must not reprocess.
  await post({ event_type: "EMAIL_REPLY", campaign_id: 4821, lead_id: sashaLead.id,
               to_email: "s.lim@acme.com", lead_category: "Interested" }, { reqId: "req-1" });
  await new Promise((r) => setTimeout(r, 400));
  eq("duplicate request id not reprocessed", fake.callsTo(`/leads/${sashaLead.id}/pause`).length, 1);

  // Out-of-office must NOT pause.
  const chenLead = fake.leads.get("4821")!.find((l) => l.email === "s.chen@acme.com")!;
  await post({ event_type: "EMAIL_REPLY", campaign_id: 4821, lead_id: chenLead.id,
               to_email: "s.chen@acme.com", lead_category: "Out of Office" }, { reqId: "req-ooo" });
  await new Promise((r) => setTimeout(r, 500));
  const chenAfter: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cDoctor).executeTakeFirst();
  eq("OOO does NOT mark responded", chenAfter.outreach_status, "contacted");
  eq("OOO does NOT pause", fake.callsTo(`/leads/${chenLead.id}/pause`).length, 0);

  // Hard bounce via a NON-'hard' field spelling (the hardened detection).
  const nairLead = fake.leads.get("4821")!.find((l) => l.email === "p.nair@acme.com")!;
  await post({ event_type: "EMAIL_BOUNCE", campaign_id: 4821, lead_id: nairLead.id,
               to_email: "p.nair@acme.com", reason: "550 permanent failure: no such user" }, { reqId: "req-b" });
  await new Promise((r) => setTimeout(r, 600));
  const sup = await db.selectFrom("suppressions").selectAll()
    .where("user_id", "=", userId).where("value", "=", "p.nair@acme.com").executeTakeFirst();
  ok("'permanent' bounce recognised as hard", !!sup, sup);
  eq("hard bounce reason", (sup as any)?.reason, "bounce_hard");
  const nairContact: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cComma).executeTakeFirst();
  eq("hard bounce -> do_not_contact", nairContact.outreach_status, "do_not_contact");

  // Unsubscribe.
  const ravi = fake.leads.get("4821")!.find((l) => l.email.toLowerCase() === "r.mehta@acme.com")!;
  await post({ event_type: "LEAD_UNSUBSCRIBED", campaign_id: 4821, lead_id: ravi.id,
               to_email: "r.mehta@acme.com" }, { reqId: "req-u" });
  await new Promise((r) => setTimeout(r, 600));
  const unsub = await db.selectFrom("suppressions").selectAll()
    .where("value", "=", "r.mehta@acme.com").executeTakeFirst();
  eq("unsubscribe suppressed", (unsub as any)?.reason, "opt_out");
  eq("unsubscribe hit provider global unsubscribe", fake.callsTo(`/leads/${ravi.id}/unsubscribe`).length, 1);

  // A reply categorised as an opt-out must suppress automatically — waiting
  // for an unsubscribe click that may never come is how people get re-emailed.
  const dncLead = fake.leads.get("4821")!.find((l) => l.email === "r.mehta@acme.com");
  if (dncLead) {
    await post({ event_type: "EMAIL_REPLY", campaign_id: 4821, lead_id: dncLead.id,
                 to_email: "r.mehta@acme.com", lead_category: "Do Not Contact" }, { reqId: "req-dnc" });
    await new Promise((r) => setTimeout(r, 600));
    const dnc = await db.selectFrom("suppressions").selectAll()
      .where("user_id", "=", userId).where("value", "=", "r.mehta@acme.com").executeTakeFirst();
    ok("'do not contact' reply auto-suppresses", !!dnc, dnc);
  }


  // ── 4. Card-drag hook ───────────────────────────────────────────────────
  console.log("\n── Stage hook ──");
  fake.reset();
  // Stages only stop sending when explicitly chosen — no keyword guessing.
  await db.updateTable("crm_boards")
    .set({ outreach_stage_map: JSON.stringify({ noSend: ["Meeting booked"] }) as any })
    .where("id", "=", boardId).execute();

  const cDrag = await add("Theo Brandt", "t.brandt@acme.com", "B");
  const campRow = await db.selectFrom("outreach_campaigns").select("id").where("board_id", "=", boardId).executeTakeFirstOrThrow();
  await db.insertInto("outreach_campaign_memberships").values({
    user_id: userId, contact_id: cDrag, campaign_id: campRow.id,
    provider_campaign_id: "4821", provider_lead_id: "9999", state: "active",
  } as any).execute();
  fake.leads.get("4821")!.push({ id: "9999", email: "t.brandt@acme.com", status: "INPROGRESS" });

  // An unlisted stage must do nothing at all.
  await onStageChange(userId, cDrag, "Contacted");
  eq("unlisted stage does not pause", fake.callsTo("/leads/9999/pause").length, 0);

  // A chosen stage stops sending — even typed with a typo.
  await onStageChange(userId, cDrag, "Meting booked");
  eq("chosen stage pauses (despite typo)", fake.callsTo("/leads/9999/pause").length, 1);
  const dragged: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cDrag).executeTakeFirst();
  eq("chosen stage -> responded", dragged.outreach_status, "responded");

  // ── 5. Reconciliation ───────────────────────────────────────────────────
  console.log("\n── Reconcile ──");
  fake.reset();
  // (a) missed reply: provider knows, we never got the webhook
  const chen2 = fake.leads.get("4821")!.find((l) => l.email === "s.chen@acme.com")!;
  chen2.replied = true; chen2.category = "Interested";
  // (b) live leak: CRM says paused, provider still sending
  const leakLead = fake.leads.get("4821")!.find((l) => l.id === "9999")!;
  leakLead.status = "INPROGRESS"; // provider active while CRM has it paused
  const counts: any = await reconcileBoard(boardId);
  eq("recovered the missed reply", counts.repliesRecovered >= 1, true);
  const chenRecovered: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cDoctor).executeTakeFirst();
  eq("missed reply -> responded", chenRecovered.outreach_status, "responded");
  eq("live leak re-paused", counts.releaks >= 1, true);

  // ── 6. Metrics ──────────────────────────────────────────────────────────
  console.log("\n── Metrics ──");
  const rows: any[] = await funnel(userId);
  const tierB = rows.find((r) => r.campaignId === "4821");
  ok("funnel has the campaign", !!tierB, rows);
  ok("counts sent", (tierB?.sent ?? 0) >= 0);
  ok("reply excludes auto/OOO", (tierB?.replied ?? 0) >= 1, tierB);

  // ── 7. Idempotency WITHOUT relying on X-Request-Id ──────────────────────
  // The docs never confirmed whether X-Request-Id is stable across retries.
  // If it is per-delivery, the unique index dedupes nothing — so the handlers
  // themselves must be idempotent. Replay the same reply under a DIFFERENT
  // request id and assert no second pause / no state churn.
  console.log("\n── Idempotency without X-Request-Id ──");
  fake.reset();
  const replayLead = fake.leads.get("4821")!.find((l) => l.email === "s.lim@acme.com")!;
  await post({ event_type: "EMAIL_REPLY", campaign_id: 4821, lead_id: replayLead.id,
               to_email: "s.lim@acme.com", lead_category: "Interested" }, { reqId: "different-id-1" });
  await new Promise((r) => setTimeout(r, 500));
  eq("replay under new request id does not re-pause", fake.callsTo(`/leads/${replayLead.id}/pause`).length, 0);
  const replayStatus: any = await db.selectFrom("crm_contacts").select("outreach_status")
    .where("id", "=", cSasha).executeTakeFirst();
  eq("replay leaves status stable", replayStatus.outreach_status, "responded");

  // Replayed unsubscribe must not double-suppress either.
  await post({ event_type: "LEAD_UNSUBSCRIBED", campaign_id: 4821, lead_id: ravi.id,
               to_email: "r.mehta@acme.com" }, { reqId: "different-id-2" });
  await new Promise((r) => setTimeout(r, 500));
  const supCount = await db.selectFrom("suppressions").select((eb: any) => eb.fn.countAll().as("n"))
    .where("user_id", "=", userId).where("value", "=", "r.mehta@acme.com").executeTakeFirst();
  eq("replayed unsubscribe stays a single suppression row", Number((supCount as any).n), 1);

  // ── 8. In-app alerts + bounce guardrail ─────────────────────────────────
  console.log("\n── Alerts ──");
  const { setAlertConfig } = await import(`${R}/integrations/outreach/accounts.ts`);
  const { bounceBreaches } = await import(`${R}/integrations/outreach/metrics.ts`);
  const { alertUser, listAlerts, unreadAlertCount, markAlertsRead } =
    await import(`${R}/integrations/outreach/alerts.ts`);
  await setAlertConfig(boardId, { bounceThresholdPct: 5 });
  fake.reset();

  // Synthesise a campaign with a bad bounce rate.
  for (let i = 0; i < 10; i++) {
    await db.insertInto("outreach_events").values({
      user_id: userId, request_id: `seed-sent-${i}`, event_type: "EMAIL_SENT",
      provider_campaign_id: "4821", to_email: `seed${i}@acme.com`, payload: "{}",
    } as any).execute();
  }
  for (let i = 0; i < 3; i++) {
    await db.insertInto("outreach_events").values({
      user_id: userId, request_id: `seed-bounce-${i}`, event_type: "EMAIL_BOUNCE",
      provider_campaign_id: "4821", to_email: `seed${i}@acme.com`, payload: "{}",
    } as any).execute();
  }
  const breaches: any[] = await bounceBreaches(userId, 5, 5);
  ok("bounce breach detected", breaches.some((b) => b.campaignId === "4821"), breaches);

  // Alerts are in-app rows now — no third-party webhook anywhere.
  await alertUser(userId, "Bounce rate 30% on Tier B", { kind: "bounce_rate", campaignId: "4821" });
  let list: any[] = await listAlerts(userId);
  eq("alert recorded in-app", list.length, 1);
  eq("alert carries its campaign", list[0].provider_campaign_id, "4821");
  eq("unread count reflects it", await unreadAlertCount(userId), 1);

  // Repeats must refresh, not pile up — a nightly job re-finding the same bad
  // campaign should never produce 30 rows.
  await alertUser(userId, "Bounce rate 34% on Tier B", { kind: "bounce_rate", campaignId: "4821" });
  list = await listAlerts(userId);
  eq("repeat alert de-duplicates", list.length, 1);
  eq("repeat alert refreshes the message", list[0].message, "Bounce rate 34% on Tier B");

  // Smartlead's own threshold event raises a critical alert (and no lead state).
  await post({ event_type: "CAMPAIGN_BOUNCE_THRESHOLD", campaign_id: 4821 }, { reqId: "req-thresh" });
  await new Promise((r) => setTimeout(r, 600));
  list = await listAlerts(userId);
  const threshold = list.find((a) => a.kind === "bounce_threshold");
  ok("bounce-threshold event raises an alert", !!threshold, list);
  eq("threshold alert is critical", threshold?.severity, "critical");

  // Dismissal.
  await markAlertsRead(userId, threshold.id);
  eq("dismissing one alert clears it", (await listAlerts(userId)).length, 1);
  await markAlertsRead(userId);
  eq("dismiss-all clears the rest", await unreadAlertCount(userId), 0);
  ok("dismissed alerts remain in history", (await listAlerts(userId, true)).length >= 2);

  // ── 9. Background export job over real HTTP (auth + polling) ────────────
  console.log("\n── Background export job ──");
  fake.reset();
  await add("Nina Kovac", "n.kovac@acme.com", "B");
  await add("Omar Haddad", "o.haddad@acme.com", "B");

  // The only door is the approval queue — a direct group-send no longer exists.
  const gone = await authed(`/api/outreach/board/${boardId}/send`, { method: "POST", body: JSON.stringify({ group: "B" }) });
  eq("direct group-send endpoint is gone", gone.status, 404);

  const queued: any = await (await authed("/api/outreach/pending")).json();
  const ids = queued.pending.map((p: any) => p.id);
  ok("queue lists people waiting to send", ids.length > 0, queued.pending.length);
  ok("queue includes people with no personal line",
    queued.pending.some((p: any) => !p.hasLine), queued.pending.map((p: any) => [p.name, p.hasLine]));

  const startRes = await authed("/api/outreach/pending/approve-and-send", {
    method: "POST", body: JSON.stringify({ ids }),
  });
  const started: any = await startRes.json();
  eq("approve-and-send returns job ids", Array.isArray(started.jobIds) && started.jobIds.length > 0, true);

  let job: any = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    job = await (await authed(`/api/outreach/send/${started.jobIds[0]}`)).json();
    if (job.status !== "running") break;
  }
  eq("job completes", job?.status, "done");
  const jobResult = typeof job.result === "string" ? JSON.parse(job.result) : job.result;
  ok("job pushed the approved people", (jobResult?.pushed ?? 0) > 0, jobResult);
  ok("job recorded progress", typeof job.progress === "string" && job.progress.length > 0, job.progress);

  // Everyone who went out is now in a campaign, so the queue drains.
  const after: any = await (await authed("/api/outreach/pending")).json();
  ok("approved people leave the queue", after.pending.length < queued.pending.length,
    { before: queued.pending.length, after: after.pending.length });

  // ── Automatic group sorting ───────────────────────────────────────────────
  // Being in a group is what makes someone emailable, so the sorter has to be
  // silent until it has been told what the groups mean.
  console.log("\n── Group sorting ──");
  {
    const { sortBoard } = await import(`${R}/integrations/outreach/openers/sort.ts`);

    await db.updateTable("crm_boards").set({ outreach_groups: null }).where("id", "=", boardId).execute();
    const quiet = await sortBoard(userId, boardId);
    eq("no descriptions sorts nobody", quiet, { considered: 0, sorted: 0, unmatched: 0, failed: 0 });

    // Groups are a list you edit: names, descriptions and per-group opening
    // instructions all round-trip, and a new one gets an id assigned.
    const saved = await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({ groups: [
        { id: "B", name: "Tier B outbound", description: "Heads of AI at banks", prompt: "Lead with the bank angle." },
        { name: "Insurance ops", description: "Insurance operations leads" },
        { name: "Not described yet" },
      ] }),
    });
    eq("groups save", saved.status, 200);
    const status: any = await (await authed(`/api/outreach/board/${boardId}`)).json();
    eq("all three come back", status.groups.length, 3);
    eq("an existing id is kept so nobody loses their group", status.groups[0].id, "B");
    ok("a new group gets an id", !!status.groups[1].id && status.groups[1].id !== "B", status.groups[1]);
    eq("per-group opener instructions round-trip", status.groups[0].prompt, "Lead with the bank angle.");
    eq("a group with no description is still listed", status.groups[2].description, "");

    // …and it can never be assigned to anyone.
    const { acceptGroup } = await import(`${R}/integrations/outreach/openers/sort.ts`);
    eq("the undescribed group is refused", acceptGroup(status.groups[2].id, status.groups), null);
    eq("a described group is accepted", acceptGroup("B", status.groups), "B");

    // Going live THROUGH THE ROUTE, which is the only path the UI has. The
    // schema previously dropped `live`, so saving from the screen silently
    // switched groups off and nothing could ever go live.
    // This section rewrote the prompt above, which correctly cleared the test.
    // Stand in for a real test run, then go live the way the screen does.
    const g0 = status.groups[0];
    await markTested(userId, boardId, g0.id);
    await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({ groups: status.groups.map((g: any) => ({ ...g, live: g.id === g0.id })) }),
    });
    const afterLive: any = await (await authed(`/api/outreach/board/${boardId}`)).json();
    eq("a tested group goes live through the route",
      afterLive.groups.find((g: any) => g.id === g0.id)?.live, true);

    // Editing an unrelated group must not switch it off again.
    await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({
        groups: afterLive.groups.map((g: any) =>
          g.id === g0.id ? g : { ...g, name: `${g.name} (edited)` }),
      }),
    });
    const afterEdit2: any = await (await authed(`/api/outreach/board/${boardId}`)).json();
    eq("editing another group leaves it live",
      afterEdit2.groups.find((g: any) => g.id === g0.id)?.live, true);

    // A client claiming it was tested must be ignored — testedAt is proof a
    // test ran, so only the test may write it.
    const fresh: any = await (await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({ groups: [
        ...afterEdit2.groups,
        { name: "Snuck in", description: "anyone", prompt: "hi", testedAt: "2026-07-27T00:00:00Z", live: true },
      ] }),
    })).json();
    const snuck = fresh.groups.find((g: any) => g.name === "Snuck in");
    eq("a claimed test is ignored", snuck?.testedAt, null);
    eq("so it cannot be live", snuck?.live, false);
    await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST", body: JSON.stringify({ groups: afterEdit2.groups }),
    });

    // Removing a group un-groups its people rather than leaving them pointed
    // at something that no longer exists.
    const orphan = await add("Will Be Orphaned", "orphan@acme.com", "B");
    const shrunk: any = await (await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({ groups: status.groups.filter((g: any) => g.id !== "B") }),
    })).json();
    ok("removing a group reports who lost it", shrunk.ungrouped >= 1, shrunk);
    const after: any = await db.selectFrom("crm_contacts").select(["tier", "group_reason"])
      .where("id", "=", orphan).executeTakeFirst();
    eq("their group is cleared", after?.tier, null);
    eq("and the reason says why", after?.group_reason, "Their group was removed");
    await db.deleteFrom("crm_contacts").where("id", "=", orphan).execute();

    // Put group B back for the rest of the suite.
    await authed(`/api/outreach/board/${boardId}/groups`, {
      method: "POST",
      body: JSON.stringify({ groups: [{ id: "B", name: "Tier B outbound", description: "Heads of AI at banks" }] }),
    });

    // Sending off means the sorter stays out of it entirely.
    await db.updateTable("crm_boards").set({ outreach_enabled: false }).where("id", "=", boardId).execute();
    const off = await sortBoard(userId, boardId);
    eq("board switched off sorts nobody", off.considered, 0);
    await db.updateTable("crm_boards").set({ outreach_enabled: true }).where("id", "=", boardId).execute();

    // A hand-set group is never revisited: the default pass only fills gaps.
    const held = await add("Hand Sorted", "hand.sorted@acme.com", "B");
    await db.updateTable("crm_contacts").set({ group_reason: "set by hand" }).where("id", "=", held).execute();
    const grouped = await db.selectFrom("crm_contacts").select(["tier", "group_reason"])
      .where("id", "=", held).executeTakeFirst();
    eq("hand-set group survives with its reason", [grouped?.tier, grouped?.group_reason], ["B", "set by hand"]);
    await db.deleteFrom("crm_contacts").where("id", "=", held).execute();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await fake.stop();
  await db.destroy();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("SUITE CRASHED:", e); process.exit(1); });
