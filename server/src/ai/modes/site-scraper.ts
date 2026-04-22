/**
 * Site scraper — given a URL, crawl up to N pages on the same domain,
 * pull readable text from each, then synthesise a structured brief
 * (what the company does, products, leadership / team, recent news,
 * notable angles for outreach). Triggered by chat intents like:
 *   "scrape https://acme.com"
 *   "crawl acme.com and tell me everything"
 *   "what's on acme.com"
 *
 * Bounded so a single request can't run away:
 *   - same-origin only (subdomain of the same registrable domain ok)
 *   - 30 pages max
 *   - 2 link-hops from the root
 *   - 8 concurrent fetches
 *   - 8s per-page timeout
 *   - 200 KB cap per page (we only need text — most binaries blow past this)
 *
 * No new deps: HTML link + text extraction is regex-based. Good enough
 * for the cleanish marketing sites this is pointed at; falls back
 * gracefully (skips a page) on weird markup.
 */
import type { AiProvider, CompletionResult } from "@app/shared";
import { env } from "../../env.js";
import { aiJson } from "../json.js";
import type { UserKeys } from "../user-keys.js";

interface PageContent {
  url: string;
  title: string;
  text: string;
}

const MAX_PAGES = 30;
const MAX_DEPTH = 2;
const CONCURRENCY = 8;
const PAGE_TIMEOUT_MS = 8000;
const PAGE_BYTE_CAP = 200_000;
const PAGE_TEXT_CAP = 12_000; // chars of cleaned text we keep per page

/** Trigger condition: explicit scrape/crawl intent + a recognisable URL
 *  in the brief. Keeps it from firing when someone happens to mention a
 *  domain in passing. */
export function looksLikeSiteScrape(s: string): boolean {
  const url = extractUrl(s);
  if (!url) return false;
  const hay = s.toLowerCase();
  return /\b(?:scrape|crawl|extract\s+(?:from|the\s+content)|read|summari[sz]e|tell\s+me\s+(?:about|everything\s+(?:about|on))|what(?:'?s|\s+is)?\s+(?:on|at))\b/.test(hay);
}

/** Pull the first http(s) URL — or a bare domain like "acme.com" — out
 *  of the brief. Returned as a normalised "https://…" string. */
export function extractUrl(s: string): string | null {
  const fullMatch = s.match(/\bhttps?:\/\/[^\s<>"']+/i);
  if (fullMatch) return normalizeUrl(fullMatch[0]);
  // Bare domain: "scrape acme.com" / "crawl acme.co.uk/products".
  const bareMatch = s.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w./-]*)?/i);
  if (bareMatch) return normalizeUrl(`https://${bareMatch[0]}`);
  return null;
}

export async function runSiteScraper(args: {
  provider: AiProvider;
  brief: string;
  userId: string;
  userKeys?: UserKeys;
}): Promise<CompletionResult | null> {
  const { provider, brief, userId, userKeys } = args;
  assertLlm(provider, userKeys);

  const root = extractUrl(brief);
  if (!root) return null;
  let rootUrl: URL;
  try {
    rootUrl = new URL(root);
  } catch {
    return { kind: "text", content: `Couldn't parse <code>${escapeHtml(root)}</code> as a URL.` };
  }
  const rootHost = registrableDomain(rootUrl.hostname);
  console.log(`[scrape] root=${rootUrl.href} host=${rootHost}`);

  // BFS crawl. We keep three structures: visited (canonical URL strings),
  // queue (next layer + depth), and pages (successful fetches).
  const visited = new Set<string>([rootUrl.href]);
  let queue: Array<{ url: string; depth: number }> = [{ url: rootUrl.href, depth: 0 }];
  const pages: PageContent[] = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const layer = queue.splice(0, CONCURRENCY);
    const fetched = await Promise.all(layer.map((j) => fetchPage(j.url)));
    const newLinks: Array<{ url: string; depth: number }> = [];

    for (let i = 0; i < layer.length; i++) {
      const job = layer[i]!;
      const result = fetched[i]!;
      if (!result) continue;
      pages.push({ url: job.url, title: result.title, text: result.text });
      if (pages.length >= MAX_PAGES) break;
      if (job.depth >= MAX_DEPTH) continue;
      for (const link of result.links) {
        let abs: URL;
        try {
          abs = new URL(link, job.url);
        } catch {
          continue;
        }
        if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
        if (registrableDomain(abs.hostname) !== rootHost) continue;
        // Drop the fragment + trailing slash so we don't re-visit /about
        // and /about#team and /about/ as three pages.
        abs.hash = "";
        const canon = abs.href.replace(/\/$/, "");
        if (visited.has(canon)) continue;
        if (looksLikeBinaryUrl(canon)) continue;
        visited.add(canon);
        newLinks.push({ url: canon, depth: job.depth + 1 });
      }
    }
    queue = newLinks.concat(queue);
  }

  console.log(`[scrape] fetched ${pages.length} pages from ${rootHost}`);

  if (pages.length === 0) {
    return {
      kind: "text",
      content: `Couldn't fetch any pages from <code>${escapeHtml(rootUrl.href)}</code>. The site may block bots, require JavaScript to render, or be unreachable.`,
    };
  }

  // Build the LLM context: page index + interleaved snippets. Order by
  // depth then alphabetical so the home page leads.
  const snippets = pages
    .slice(0, 25)
    .map((p) => `[${p.title || p.url}](${p.url})\n${p.text.slice(0, 4000)}`)
    .join("\n\n---\n\n");

  let html = "";
  try {
    const out = await aiJson<{ summary: string }>(
      provider,
      `You write a structured research brief for a sales / BD reader from a website crawl.

The reader needs to QUICKLY understand:
  • What the company does (1 sentence + 1 short paragraph of nuance).
  • Their actual product(s) / offering(s) — concrete, not marketing speak.
  • Who's mentioned by name (founders / leadership / advisors / authors).
  • Recent news, posts, milestones (with cited links).
  • Anything quirky or non-obvious worth bringing up in outreach.

STRICT RULES
  - Cite every specific claim with an inline markdown link [label](url).
  - Skip generic platitudes ("seasoned team", "innovative platform"). If a
    line could describe any company in their space, cut it.
  - Output HTML only: <p>, <strong>, <em>, <ul>, <li>, <a href>, <br>. No
    other tags, no inline styles, no <h1>-<h6>.
  - 800-1500 characters of prose. Cite 4-10 distinct pages.
  - End with a short "Outreach hooks:" <ul> of 2-4 specific things to
    reference in a first-touch message.

Return {"summary": "<p>…</p><p><strong>What they do.</strong> …</p><ul>…</ul>"}`,
      `Site: ${rootUrl.href}\nPages crawled: ${pages.length}\n\n${snippets}`,
      { maxTokens: 3000, userId, userKeys },
    );
    html = sanitizeHtml(out.summary?.trim() ?? "");
  } catch (err) {
    console.error("[scrape] synthesis failed:", (err as Error).message);
  }

  if (!html) {
    // Fallback: render a plain page index so the user gets *something* even
    // if the LLM step blew up. Beats a "didn't work" message.
    const list = pages
      .slice(0, 30)
      .map((p) => `<li><a href="${escapeAttr(p.url)}" target="_blank" rel="noreferrer">${escapeHtml(p.title || p.url)}</a></li>`)
      .join("");
    html = `<p>Crawled <strong>${pages.length}</strong> pages on <code>${escapeHtml(rootHost)}</code>. Synthesis step failed — here's the page index:</p><ul>${list}</ul>`;
  }

  return { kind: "text", content: html };
}

// ─── crawl helpers ────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<{ title: string; text: string; links: string[] } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NontrivialScraper/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const reader = r.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (received < PAGE_BYTE_CAP) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      chunks.push(value);
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks));
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
    const text = extractText(html).slice(0, PAGE_TEXT_CAP);
    const links = extractLinks(html);
    return { title, text, links };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function extractLinks(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? m[3] ?? "";
    if (!href) continue;
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    out.push(href);
  }
  return out;
}

function extractText(html: string): string {
  return html
    // Drop entire script/style/noscript/svg/template blocks.
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Drop typical chrome regions — best-effort, by tag.
    .replace(/<(nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Drop comments.
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Drop tags but keep their text.
    .replace(/<[^>]+>/g, " ")
    // Decode the handful of named entities that actually matter.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeBinaryUrl(url: string): boolean {
  return /\.(?:pdf|zip|docx?|xlsx?|pptx?|jpg|jpeg|png|gif|webp|svg|ico|mp4|mp3|webm|woff2?|ttf|eot|css|js|map|json|xml)(?:\?.*)?$/i.test(url);
}

function normalizeUrl(s: string): string {
  try {
    const u = new URL(s);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return s;
  }
}

/** Strip the leftmost label of a hostname IF the result still has a TLD.
 *  Crude but enough to keep "blog.acme.com" and "acme.com" inside the
 *  same crawl scope. Doesn't try to handle public-suffix edge cases. */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

// ─── HTML safety + helpers ────────────────────────────────────────────────

function sanitizeHtml(html: string): string {
  const allowed = /^(p|strong|em|ul|ol|li|br|a|code)$/i;
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    const tagLc = tag.toLowerCase();
    if (!allowed.test(tagLc)) return "";
    if (match.startsWith("</")) return `</${tagLc}>`;
    if (tagLc === "a") {
      const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
      const href = /^https?:\/\//i.test(raw) ? raw : "";
      return href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">` : "<a>";
    }
    return `<${tagLc}>`;
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function assertLlm(provider: AiProvider, userKeys?: UserKeys) {
  const llm =
    provider === "openai" ? (userKeys?.openai ?? env.OPENAI_API_KEY) :
    provider === "anthropic" ? (userKeys?.anthropic ?? env.ANTHROPIC_API_KEY) :
    (userKeys?.deepseek ?? env.DEEPSEEK_API_KEY);
  if (!llm) throw new Error(`${provider.toUpperCase()} key missing — add it in Settings → API keys.`);
}
