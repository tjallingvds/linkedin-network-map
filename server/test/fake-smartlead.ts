/**
 * Fake Smartlead API. Records every request so the integration suite can assert
 * what the CRM actually sent (payload shape, suppression flags, pause calls),
 * and lets a test drive the campaign-lead state to simulate reply recovery.
 */
import http from "node:http";

export interface Recorded { method: string; path: string; body: any }

export interface CampaignLeadState {
  id: string;
  email: string;
  status: string;
  replied?: boolean;
  category?: string;
}

export class FakeSmartlead {
  server: http.Server;
  port = 0;
  calls: Recorded[] = [];
  /** campaignId -> leads Smartlead "knows about" */
  leads = new Map<string, CampaignLeadState[]>();
  /** Make the next lead-list read fail, to exercise the unreadable path. */
  failNextLeadFetch = false;
  private nextId = 1000;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(port = 0): Promise<string> {
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as any).port;
    return `http://127.0.0.1:${this.port}/api/v1`;
  }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }

  reset() { this.calls = []; }
  callsTo(fragment: string) { return this.calls.filter((c) => c.path.includes(fragment)); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const url = new URL(req.url!, `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    this.calls.push({ method: req.method!, path, body });

    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    // Every call must carry the api_key query param.
    if (!url.searchParams.get("api_key")) return json(401, { error: "no api key" });

    // GET /campaigns/
    if (req.method === "GET" && path.endsWith("/api/v1/campaigns/")) {
      return json(200, [{ id: 4821, name: "Tier B outbound", status: "ACTIVE" }]);
    }

    // POST /campaigns/{id}/leads  — add leads
    let m = path.match(/\/campaigns\/([^/]+)\/leads$/);
    if (m && req.method === "POST") {
      const cid = m[1];
      const list = this.leads.get(cid) ?? [];
      for (const l of body?.lead_list ?? []) {
        if (list.some((x) => x.email.toLowerCase() === String(l.email).toLowerCase())) continue;
        list.push({ id: String(this.nextId++), email: l.email, status: "INPROGRESS" });
      }
      this.leads.set(cid, list);
      return json(200, { ok: true, upload_count: body?.lead_list?.length ?? 0 });
    }

    // GET /campaigns/{id}/leads — paginated list
    if (m && req.method === "GET") {
      if (this.failNextLeadFetch) return json(500, { message: "Smartlead is having a moment" });
      const cid = m[1];
      const all = this.leads.get(cid) ?? [];
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const page = all.slice(offset, offset + limit);
      return json(200, {
        total_leads: all.length,
        data: page.map((l) => ({
          status: l.status,
          is_replied: !!l.replied,
          lead_category: l.category ?? null,
          lead: { id: l.id, email: l.email },
        })),
      });
    }

    // POST /campaigns/{cid}/leads/{lid}/pause | /resume
    m = path.match(/\/campaigns\/([^/]+)\/leads\/([^/]+)\/(pause|resume)$/);
    if (m && req.method === "POST") {
      const [, cid, lid, action] = m;
      const lead = (this.leads.get(cid) ?? []).find((l) => l.id === lid);
      if (!lead) return json(404, { error: "lead not found" });
      lead.status = action === "pause" ? "PAUSED" : "INPROGRESS";
      return json(200, { ok: true });
    }

    // GET /leads/by-email
    if (req.method === "GET" && path.endsWith("/api/v1/leads/by-email")) {
      const email = (url.searchParams.get("email") ?? "").toLowerCase();
      for (const list of this.leads.values()) {
        const hit = list.find((l) => l.email.toLowerCase() === email);
        if (hit) return json(200, { id: hit.id, email: hit.email });
      }
      return json(404, { error: "not found" });
    }

    // POST /leads/{id}/unsubscribe
    m = path.match(/\/leads\/([^/]+)\/unsubscribe$/);
    if (m && req.method === "POST") {
      for (const list of this.leads.values()) {
        const hit = list.find((l) => l.id === m![1]);
        if (hit) hit.status = "BLOCKED";
      }
      return json(200, { ok: true });
    }

    // POST /leads/add-domain-block-list
    if (req.method === "POST" && path.endsWith("/leads/add-domain-block-list")) {
      return json(200, { ok: true });
    }

    return json(404, { error: `unhandled ${req.method} ${path}` });
  }
}
