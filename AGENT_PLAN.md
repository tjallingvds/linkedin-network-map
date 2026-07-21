# Autonomous Outreach Agent — Plan

The goal: outreach runs itself. Agents do **discovery, filtering, enrichment,
and drafting** without the user's input, and the only human step is a **final
approval of proposed people** (e.g. an end-of-day check-in).

---

## The flow

```
User: "find me 50 qualified AI leaders at fintechs"
        │
        ▼
① Search Agent — loops until 50 QUALIFIED are found (not 50 raw hits)
        │  search → filter → dedupe → repeat next page / refined query
        ▼
② Proposed list — a clear, reviewable list. Nothing touches the pipeline yet.
        │  user ticks the ones they want → "Add to pipeline"
        ▼
③ On add → auto-enrich each person (ONLY if they have a LinkedIn link)
        │  email · city · country · skill — all run automatically
        ▼
   Live in the CRM, fully enriched, ready for outreach.
```

---

## Requirements (from the user)

1. **A clear Proposed list** of people to add to the pipeline — reviewable before anything enters the CRM.
2. **Auto-run the enrichment actions on add** (Get email, Find city, Classify country, Classify skill) automatically when a person is added — **but only if the row has a LinkedIn link.** No LinkedIn → skip (those are all LinkedIn/web lookups).
3. **Agentic search that loops until the requested count is reached** — 50 means 50 *qualified*, not 50 raw — and is **properly filtered**.
4. **A clear progress dashboard for the running agent, in the sidebar.**
5. **A little animation on that sidebar tab while a run is active.**

---

## Pipeline stages (the agents)

| Stage | What it does | Maps to |
|---|---|---|
| **Scout** | Runs the ICP brief on a schedule, pulls new people | existing `find` mode + saved searches |
| **Qualify / Filter** | Scores vs ICP; drops anyone already in CRM, already connected, or in a Cold/Ignored column | "Connected & new" filter, external-CRM cleanup, Cold/Ignored exclusion (built) |
| **Enrich** | Apollo email + city + country + skill — gated on LinkedIn presence | `/enrich`, `/classify-city`, `/classify-country`, `/classify-skill` (built) |
| **Rank** | Orders by fit + a signal (recent job change, funding, seniority); low-confidence flagged, not auto-included | new — a scoring step |
| **Draft** | Personalized first-touch per person, grounded in background | existing `draft` mode |
| **Propose** | Lands in a "Proposed" holding area / review inbox | new — a stage + UI |

---

## The human checkpoint — the Proposed inbox

One reviewable list. Each row shows:
- **Who** — name, title, company, LinkedIn.
- **Why it was picked** — the fit rationale (provenance).
- **Enriched data** — email, city, etc.
- **The draft message.**

Bulk **Approve / Reject / Edit**. One approval → into the pipeline. That is the user's only input.

---

## What makes it trustworthy (enterprise, not a black box)

- **Provenance** on every proposal ("CTO at a Series-B fintech, matches your 'AI leaders' brief, joined 2mo ago").
- **Hard guardrails** — dedup, exclusion rules, a **daily cap** (e.g. 30 proposals), a **confidence threshold** so borderline picks are flagged rather than slipped in.
- **Dry-run + audit log** — see what it *would* do, and a record of every autonomous action.

---

## Foundation: a background job runner (also permanently fixes the Railway timeout)

Long work must **not** run inside a single HTTP request — Railway (and any host)
will drop/timeout a multi-minute request, and a deploy restart kills it. So:

- A **`jobs` table** in Postgres (Kysely): `{ id, type, status, progress, target, result, board_id, created_at }`.
- `POST /agent/run` → **inserts a job, returns instantly** (`202` + job id). No waiting.
- A **worker loop** drains `queued` jobs and runs the pipeline, updating `progress` as it goes.
  - Start: an **in-process worker** (a loop that drains the table). Simplest.
  - Robust: a **second Railway service** (worker-only, no public port) so heavy agent work can't slow web requests and web deploys don't interrupt a running job.
- `GET /jobs/:id` → status → **powers the sidebar dashboard**. Survives restarts because state lives in the DB, not the request.

This single foundation gives us: no more 502s on long ops, the loop-until-target
search, the auto-enrich chain, and the live sidebar progress — all from the same
`jobs` table + worker + status endpoint.

---

## What exists vs. what's new

**Reuses (already built):** `find` search mode, `/enrich` (Apollo email), `/classify-city`, `/classify-country`, `/classify-skill`, `draft` mode, "Connected & new" + Cold/Ignored exclusions, board stages.

**New to build:**
1. Job/worker infra (`jobs` table + worker + status endpoint).
2. Proposed-list UI + a "Proposed" holding stage.
3. Sidebar Agents dashboard + live animation.
4. Loop-until-target wrapper around search + the filter/dedup gate.
5. Ranking / confidence scoring.

---

## Build order (phased)

1. **Job/worker foundation** — jobs table, in-process worker, status endpoint. *(Also kills the Railway timeout.)*
2. **Loop-until-target search → Proposed list** — the core value.
3. **Auto-enrich-on-add** chain, gated on LinkedIn.
4. **Sidebar Agents dashboard + animation.**
5. **Ranking / confidence gate + batch-approve inbox.**

---

## Open decisions

1. **Target/brief input** — reuse the existing search box (type the brief + a number), or a dedicated "New agent run" form (count + explicit filters)?
2. **"Qualified" definition** — (a) LLM judges fit against the brief, (b) hard rules the user sets (seniority, company size, geography), or (c) both?
