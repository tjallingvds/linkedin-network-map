/**
 * Local-only mock of the server API. Activated when VITE_MOCK_AUTH=1.
 *
 * Persists to localStorage so boards + contacts survive refreshes. Endpoints
 * mirror the real server so the app code doesn't branch — `api.post(...)` in
 * mock mode just intercepts before hitting the network.
 */
import type { CompletionResult, CrmBoard, CrmContact, Prospect } from "@app/shared";

const LS_BOARDS = "nontrivial.mock.boards";
const LS_CONTACTS = "nontrivial.mock.contacts";
const LS_USAGE = "nontrivial.mock.usage";

// ---------- Mock usage tracking ----------

interface MockUsage {
  apollo: number;
  tavily: number;
  llmTokens: number;
  costUsd: number;
}
function readUsage(): MockUsage {
  try {
    const raw = localStorage.getItem(LS_USAGE);
    if (raw) return JSON.parse(raw) as MockUsage;
  } catch { /* ignore */ }
  return { apollo: 0, tavily: 0, llmTokens: 0, costUsd: 0 };
}
function bumpUsage(patch: Partial<MockUsage>) {
  const cur = readUsage();
  const next: MockUsage = {
    apollo: cur.apollo + (patch.apollo ?? 0),
    tavily: cur.tavily + (patch.tavily ?? 0),
    llmTokens: cur.llmTokens + (patch.llmTokens ?? 0),
    costUsd: cur.costUsd + (patch.costUsd ?? 0),
  };
  localStorage.setItem(LS_USAGE, JSON.stringify(next));
}

// ---------- Seed ----------

const SEED_BOARD_ID = "mock-board-1";

const SEED_BOARD: CrmBoard = {
  id: SEED_BOARD_ID,
  name: "Outreach pipeline",
  emoji: "📣",
  contactCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SEED_CONTACTS: CrmContact[] = [
  { id: "c1", boardId: SEED_BOARD_ID, name: "Maya Okafor", title: "VP Engineering", company: "Lumen AI",
    email: "maya@lumen.ai", phone: null, linkedin: "linkedin.com/in/mokafor",
    stage: "meeting", temp: "hot", sent: 3, opens: 8, replies: 2,
    lastTouch: "2h ago", nextStep: "Demo Thu 2pm", source: "VPs of Eng · NYC AI seed",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 0, createdAt: "", updatedAt: "" },
  { id: "c2", boardId: SEED_BOARD_ID, name: "Ravi Mehta", title: "Head of Eng", company: "Glyphic",
    email: "ravi@glyphic.com", phone: null, linkedin: "linkedin.com/in/ravimehta",
    stage: "replied", temp: "warm", sent: 2, opens: 6, replies: 1,
    lastTouch: "Yesterday", nextStep: "Send case study", source: "VPs of Eng · NYC AI seed",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 1, createdAt: "", updatedAt: "" },
  { id: "c3", boardId: SEED_BOARD_ID, name: "Sasha Lim", title: "VP Eng", company: "Northbeam Labs",
    email: "sasha@northbeam.io", phone: null, linkedin: null,
    stage: "contacted", temp: "warm", sent: 1, opens: 2, replies: 0,
    lastTouch: "2d ago", nextStep: "Follow-up #1", source: "VPs of Eng · NYC AI seed",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 2, createdAt: "", updatedAt: "" },
  { id: "c4", boardId: SEED_BOARD_ID, name: "Daniel Foster", title: "CTO", company: "Quill Systems",
    email: "daniel@quill.dev", phone: null, linkedin: null,
    stage: "new", temp: "hot", sent: 0, opens: 0, replies: 0,
    lastTouch: null, nextStep: "First touch", source: "Founders · just raised",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 3, createdAt: "", updatedAt: "" },
  { id: "c5", boardId: SEED_BOARD_ID, name: "Priya Nair", title: "Head of Eng", company: "Mosaic AI",
    email: "priya@mosaicai.com", phone: null, linkedin: null,
    stage: "contacted", temp: "cold", sent: 1, opens: 0, replies: 0,
    lastTouch: "3d ago", nextStep: "Try LinkedIn", source: "VPs of Eng · NYC AI seed",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 4, createdAt: "", updatedAt: "" },
  { id: "c6", boardId: SEED_BOARD_ID, name: "Theo Brandt", title: "VP Eng", company: "Cipher.ai",
    email: "theo@cipher.ai", phone: null, linkedin: null,
    stage: "replied", temp: "hot", sent: 2, opens: 4, replies: 1,
    lastTouch: "1d ago", nextStep: "Propose times", source: "VPs of Eng · NYC AI seed",
    notes: null, lastTouchAt: null, lastTouchDirection: null, positionIdx: 5, createdAt: "", updatedAt: "" },
];

// ---------- Storage ----------

function readBoards(): CrmBoard[] {
  try {
    const raw = localStorage.getItem(LS_BOARDS);
    if (raw) return JSON.parse(raw) as CrmBoard[];
  } catch { /* ignore */ }
  // First-run seed.
  const boards = [SEED_BOARD];
  writeBoards(boards);
  writeContacts(SEED_CONTACTS);
  return boards;
}

function writeBoards(bs: CrmBoard[]) {
  localStorage.setItem(LS_BOARDS, JSON.stringify(bs));
}

function readContacts(): CrmContact[] {
  try {
    const raw = localStorage.getItem(LS_CONTACTS);
    if (raw) return JSON.parse(raw) as CrmContact[];
  } catch { /* ignore */ }
  return [];
}

function writeContacts(cs: CrmContact[]) {
  localStorage.setItem(LS_CONTACTS, JSON.stringify(cs));
}

function boardWithCount(b: CrmBoard, allContacts: CrmContact[]): CrmBoard {
  return { ...b, contactCount: allContacts.filter((c) => c.boardId === b.id).length };
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// ---------- Search result generator ----------

const FIRST_NAMES = ["Alex", "Jordan", "Sam", "Casey", "Morgan", "Taylor", "Avery", "Riley", "Quinn", "Drew"];
const LAST_NAMES = ["Chen", "Park", "Kim", "Singh", "Ramirez", "Wolf", "Hayes", "Patel", "Nguyen", "Okoye"];
const COMPANIES = ["Lumen AI", "Glyphic", "Northbeam Labs", "Quill Systems", "Mosaic AI", "Cipher.ai", "Drift Labs", "Cobalt AI", "Atlas AI", "Helio Robotics"];
const CITIES = ["Brooklyn, NY", "Manhattan, NY", "NYC", "Long Island City, NY"];

function mockSearchResult(query: string): CompletionResult {
  const prospects: Prospect[] = Array.from({ length: 6 }, (_, i) => {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const last = LAST_NAMES[(i * 3) % LAST_NAMES.length]!;
    const company = COMPANIES[i % COMPANIES.length]!;
    return {
      id: `mock-${Date.now()}-${i}`,
      name: `${first} ${last}`,
      title: "VP of Engineering",
      company,
      loc: CITIES[i % CITIES.length]!,
      email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      emailConf: 80 + ((i * 3) % 20),
      phone: null,
      linkedin: `linkedin.com/in/${first.toLowerCase()}${last.toLowerCase()}`,
      headcount: `${12 + i * 4} ppl`,
      funding: `Seed · $${(3 + i).toFixed(1)}M`,
      signals: [
        { kind: i % 2 === 0 ? "hot" : "fresh", text: i % 2 === 0 ? "Hiring senior engineers" : "Recently promoted", when: `${i + 1}d ago` },
      ],
      past: [{ co: ["Stripe", "Google", "Anthropic", "Vercel"][i % 4]!, role: "Senior Engineer", when: "2019–2024" }],
      matchPct: 92 - i * 2,
    };
  });
  return {
    kind: "prospects",
    summary: `Demo result · ${prospects.length} sample matches for <strong>${query.slice(0, 60)}</strong>. Set real API keys + start the backend for live web search.`,
    prospects,
  };
}

function mockDrafts(recipients: Prospect[]): CompletionResult {
  return {
    kind: "drafts",
    drafts: recipients.map((p) => ({
      recipientId: p.id,
      recipientName: p.name,
      recipientCompany: p.company,
      email: {
        subject: `Re: ${p.company}`,
        body: `Hi ${p.name.split(" ")[0]},\n\nNoticed ${p.company}'s momentum — ${p.signals[0]?.text.toLowerCase() ?? "your recent work"}. We help engineering leaders ship 3× faster.\n\nOpen to a 15-min chat next week?\n\n— You`,
      },
      linkedin: `Hi ${p.name.split(" ")[0]} — quick note re: ${p.company}. Worth a chat?`,
    })),
  };
}

// ---------- Dispatcher ----------

export function isMockApiEnabled(): boolean {
  return import.meta.env.VITE_MOCK_AUTH === "1";
}

/**
 * Returns a mock response for a path, or `undefined` if the path should go
 * to the real backend.
 */
export async function mockDispatch(method: string, path: string, body?: unknown): Promise<unknown | undefined> {
  // Auth is handled in auth.tsx; chat session is the real check which we still allow to fail normally.
  // Chats
  if (method === "POST" && path === "/api/chats") {
    return { id: uid("mock-chat") };
  }
  const completionMatch = path.match(/^\/api\/chats\/[^/]+\/completion$/);
  if (method === "POST" && completionMatch) {
    const req = body as { content: string; mode: "find" | "enrich" | "draft"; recipients?: Prospect[] };
    await new Promise((r) => setTimeout(r, 1200));

    // Draft: ~1 credit per recipient (1000 tokens).
    const n = req.recipients?.length ?? 1;
    if (req.mode === "draft") {
      bumpUsage({ llmTokens: n * 1000, costUsd: n * 0.0008 });
      return { result: mockDrafts(req.recipients ?? []) };
    }
    bumpUsage({ tavily: 3, llmTokens: 3500, costUsd: 0.028 });
    return { result: mockSearchResult(req.content) };
  }

  // CRM boards
  if (method === "GET" && path === "/api/crm/boards") {
    const contacts = readContacts();
    return { boards: readBoards().map((b) => boardWithCount(b, contacts)) };
  }
  if (method === "POST" && path === "/api/crm/boards") {
    const req = body as { name: string; emoji?: string };
    const b: CrmBoard = {
      id: uid("board"),
      name: req.name,
      emoji: req.emoji ?? "📣",
      contactCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeBoards([...readBoards(), b]);
    return b;
  }
  const boardUpdateMatch = path.match(/^\/api\/crm\/boards\/([^/]+)$/);
  if (method === "PATCH" && boardUpdateMatch) {
    const id = boardUpdateMatch[1]!;
    const req = body as { name?: string; emoji?: string };
    const boards = readBoards().map((b) =>
      b.id === id ? { ...b, ...req, updatedAt: new Date().toISOString() } : b,
    );
    writeBoards(boards);
    return boards.find((b) => b.id === id);
  }
  if (method === "DELETE" && boardUpdateMatch) {
    const id = boardUpdateMatch[1]!;
    writeBoards(readBoards().filter((b) => b.id !== id));
    writeContacts(readContacts().filter((c) => c.boardId !== id));
    return undefined;
  }

  // CRM contacts
  const listContactsMatch = path.match(/^\/api\/crm\/boards\/([^/]+)\/contacts$/);
  if (method === "GET" && listContactsMatch) {
    const boardId = listContactsMatch[1]!;
    return {
      contacts: readContacts()
        .filter((c) => c.boardId === boardId)
        .sort((a, b) => a.positionIdx - b.positionIdx),
    };
  }
  if (method === "POST" && listContactsMatch) {
    const boardId = listContactsMatch[1]!;
    const req = body as Partial<CrmContact> & { name: string };
    const now = new Date().toISOString();
    const contact: CrmContact = {
      id: uid("c"),
      boardId,
      name: req.name,
      title: req.title ?? null,
      company: req.company ?? null,
      email: req.email ?? null,
      phone: req.phone ?? null,
      linkedin: req.linkedin ?? null,
      stage: req.stage ?? "new",
      temp: req.temp ?? "warm",
      sent: req.sent ?? 0,
      opens: req.opens ?? 0,
      replies: req.replies ?? 0,
      lastTouch: req.lastTouch ?? null,
      lastTouchAt: req.lastTouchAt ?? null,
      lastTouchDirection: req.lastTouchDirection ?? null,
      nextStep: req.nextStep ?? "First touch",
      source: req.source ?? "Manual",
      notes: req.notes ?? null,
      positionIdx: readContacts().filter((c) => c.boardId === boardId).length,
      createdAt: now,
      updatedAt: now,
    };
    writeContacts([...readContacts(), contact]);
    return contact;
  }

  const bulkMatch = path.match(/^\/api\/crm\/boards\/([^/]+)\/contacts\/bulk$/);
  if (method === "POST" && bulkMatch) {
    const boardId = bulkMatch[1]!;
    const req = body as { contacts: (Partial<CrmContact> & { name: string })[] };
    const now = new Date().toISOString();
    const existing = readContacts();
    const startIdx = existing.filter((c) => c.boardId === boardId).length;
    const added: CrmContact[] = req.contacts.map((r, i) => ({
      id: uid("c"),
      boardId,
      name: r.name,
      title: r.title ?? null,
      company: r.company ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      linkedin: r.linkedin ?? null,
      stage: r.stage ?? "new",
      temp: r.temp ?? "warm",
      sent: r.sent ?? 0,
      opens: r.opens ?? 0,
      replies: r.replies ?? 0,
      lastTouch: r.lastTouch ?? null,
      lastTouchAt: r.lastTouchAt ?? null,
      lastTouchDirection: r.lastTouchDirection ?? null,
      nextStep: r.nextStep ?? "First touch",
      source: r.source ?? "Import",
      notes: r.notes ?? null,
      positionIdx: startIdx + i,
      createdAt: now,
      updatedAt: now,
    }));
    writeContacts([...existing, ...added]);
    return { inserted: added.length };
  }

  const enrichMatch = path.match(/^\/api\/crm\/boards\/([^/]+)\/enrich$/);
  if (method === "POST" && enrichMatch) {
    const boardId = enrichMatch[1]!;
    const contacts = readContacts();
    const onBoard = contacts.filter((c) => c.boardId === boardId);
    // Simulate Apollo fill.
    const updated = contacts.map((c) => {
      if (c.boardId !== boardId) return c;
      if (!c.email && c.name && c.company) {
        const dom = c.company.toLowerCase().replace(/[^a-z]/g, "") + ".com";
        const first = c.name.split(" ")[0]?.toLowerCase() ?? "x";
        return { ...c, email: `${first}@${dom}` };
      }
      return c;
    });
    writeContacts(updated);
    const enriched = updated.filter((c, i) => c.email && !contacts[i]?.email).length;
    bumpUsage({ apollo: onBoard.length, costUsd: onBoard.length * 0.01 });
    return { enriched, skipped: onBoard.length - enriched, total: onBoard.length };
  }

  const contactMatch = path.match(/^\/api\/crm\/contacts\/([^/]+)$/);
  if (method === "PATCH" && contactMatch) {
    const id = contactMatch[1]!;
    const req = body as Partial<CrmContact>;
    const contacts = readContacts().map((c) =>
      c.id === id ? { ...c, ...req, updatedAt: new Date().toISOString() } : c,
    );
    writeContacts(contacts);
    return contacts.find((c) => c.id === id);
  }
  if (method === "DELETE" && contactMatch) {
    const id = contactMatch[1]!;
    writeContacts(readContacts().filter((c) => c.id !== id));
    return undefined;
  }

  // Usage endpoint — matches server/src/routes/usage.ts shape.
  if (method === "GET" && path === "/api/usage") {
    const u = readUsage();
    return {
      buckets: [
        { label: "Search", used: u.tavily, max: 10_000, unit: "" },
        { label: "Enrich", used: u.apollo, max: 5_000, unit: "" },
        { label: "LLM", used: u.llmTokens, max: 5_000_000, unit: "" },
      ],
      costUsd: u.costUsd,
    };
  }

  // Auth session — return the stored fake user if any.
  if (method === "GET" && path === "/api/auth/session") {
    try {
      const raw = localStorage.getItem("nontrivial.mock.user");
      return { user: raw ? JSON.parse(raw) : null };
    } catch {
      return { user: null };
    }
  }

  return undefined; // not intercepted
}
