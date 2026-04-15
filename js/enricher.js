/**
 * Enricher — registers a web_search tool (backed by Tavily) with AIProvider,
 * then lets the AI decide what/how to search via tool calling.
 *
 * Flow:
 * 1. Tavily key → registers web_search tool on AIProvider
 * 2. AI calls web_search dynamically (choosing queries, depth, count)
 * 3. Results flow back to AI, which extracts structured background
 * 4. Profiles cached in localStorage (7-day TTL)
 */

const Enricher = (() => {
  let _tavilyKey = null;
  const CACHE_KEY = 'enrichment_cache';
  const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

  // Tool schema for web_search — registered with AIProvider
  const WEB_SEARCH_SCHEMA = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to find information about a person or topic' },
      search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth — use basic for quick lookups, advanced for thorough research' },
      max_results: { type: 'integer', description: 'Number of results to return (1-20)', minimum: 1, maximum: 20 },
    },
    required: ['query'],
  };

  function configure(tavilyKey) {
    _tavilyKey = tavilyKey;
    // Register/update the web_search tool with AIProvider
    if (_tavilyKey) {
      AIProvider.registerTool(
        'web_search',
        'Search the web for information about people, companies, or topics. Returns titles, URLs, and content snippets from relevant pages. Use this to find professional backgrounds, LinkedIn profiles, education history, previous roles, and other public information.',
        WEB_SEARCH_SCHEMA,
        _handleWebSearchTool,
      );
    } else {
      AIProvider.unregisterTool('web_search');
    }
  }

  function getKey() { return _tavilyKey; }
  function isConfigured() { return !!_tavilyKey; }

  // ─── Search progress tracking ───
  let _searchCount = 0;
  let _onSearchProgress = null;

  function setSearchProgressCallback(fn) { _onSearchProgress = fn; }
  function resetSearchCount() { _searchCount = 0; }

  // ─── Cache ───
  function _getCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    } catch { return {}; }
  }

  function _setCache(cache) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  }

  function _cacheKey(person) {
    return `${person.f}_${person.l}_${(person.c || '').slice(0, 20)}`.toLowerCase().replace(/\s+/g, '_');
  }

  function getCached(person) {
    const cache = _getCache();
    const key = _cacheKey(person);
    const entry = cache[key];
    // Expire after 7 days
    if (entry && Date.now() - entry.ts < 7 * 24 * 60 * 60 * 1000) {
      return entry.data;
    }
    return null;
  }

  function _saveToCache(person, data) {
    const cache = _getCache();
    cache[_cacheKey(person)] = { data, ts: Date.now() };
    _setCache(cache);
  }

  // ─── Collected sources (reset per enrichment call) ───
  let _collectedSources = [];

  // ─── Web Search Tool Handler (called by AI via tool use) ───
  async function _handleWebSearchTool(params) {
    const query = params.query;
    const depth = params.search_depth || 'basic';
    const max = Math.min(Math.max(params.max_results || 5, 1), 20);

    _searchCount++;
    if (_onSearchProgress) _onSearchProgress(_searchCount, query);

    const results = await _tavilySearch(query, depth, max);
    if (!results.length) return 'No results found.';

    // Collect sources for the profile
    results.forEach(r => {
      if (r.url && !_collectedSources.some(s => s.url === r.url)) {
        _collectedSources.push({ title: r.title, url: r.url });
      }
    });

    return results.map(r =>
      `[${r.title}](${r.url})\n${r.content}`
    ).join('\n\n---\n\n');
  }

  // ─── Tavily Search ───
  async function _tavilySearch(query, searchDepth = 'basic', maxResults = 5) {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: _tavilyKey,
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Tavily error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
    }));
  }

  // ─── Public: Enrich a single person ───
  async function enrichPerson(person) {
    if (!_tavilyKey) throw new Error('Tavily API key not configured');
    if (!AIProvider.getProvider()) throw new Error('AI provider not configured');

    // Check cache first
    const cached = getCached(person);
    if (cached) return cached;

    const name = `${person.f} ${person.l}`;
    const company = person.c || 'unknown company';
    const position = person.p || 'unknown role';

    // Reset collected sources for this enrichment
    _collectedSources = [];

    // Use tool-based approach — let AI decide what to search
    const systemPrompt = `You research professional backgrounds of real people using web search.

You MUST use the web_search tool to find information. Search for their LinkedIn profile, professional background, education, and career history. You may call web_search multiple times with different queries if the first search doesn't return enough info.

After gathering search results, return a JSON object:
{
  "previousRoles": [{"title": "...", "company": "...", "period": "..."}],
  "education": [{"school": "...", "degree": "...", "field": "...", "year": "..."}],
  "skills": ["skill1", "skill2"],
  "bio": "One-sentence professional summary",
  "notableAchievements": ["achievement1"],
  "location": "City, Country",
  "linkedinHeadline": "Their LinkedIn headline if found",
  "linkedinUrl": "Their LinkedIn profile URL if found, or empty string",
  "interests": ["interest1", "interest2"],
  "talkingPoints": ["A specific talking point for outreach based on their background"]
}

Rules:
- Only include information you're confident belongs to THIS specific person (${name} at ${company}).
- If a field has no data, use an empty array or empty string.
- Keep it factual. No speculation.
- previousRoles should NOT include their current role at ${company}.
- For talkingPoints: suggest 1-3 specific, personalized conversation starters based on their background (e.g. shared education, career transitions, recent projects).
- Return ONLY the JSON object as your final answer.`;

    const userMessage = `Research the professional background of ${name}, currently ${position} at ${company}. Find their previous roles, education, skills, and any notable achievements.`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, userMessage, {
        temperature: 0.1,
        maxTokens: 800,
        useTools: true,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const profile = JSON.parse(jsonMatch[0]);
        profile.sources = _collectedSources.slice(0, 8);
        _saveToCache(person, profile);
        return profile;
      }
    } catch (e) {
      console.warn('Tool-based enrichment failed, trying fallback:', e);
    }

    // Fallback: direct Tavily search + AI summarization (no tool calling)
    _collectedSources = [];
    try {
      const searchQuery = person.c
        ? `${name} ${person.c} LinkedIn professional background`
        : `${name} ${position} LinkedIn professional background`;

      const results = await _tavilySearch(searchQuery);
      if (results.length) {
        // Collect sources from fallback search
        results.forEach(r => {
          if (r.url && !_collectedSources.some(s => s.url === r.url)) {
            _collectedSources.push({ title: r.title, url: r.url });
          }
        });
        const searchContext = results.map(r => `[${r.title}](${r.url})\n${r.content}`).join('\n\n---\n\n');
        const { text } = await AIProvider.aiCall(
          `Extract professional background for ${name} at ${company}. Return JSON: {"previousRoles":[{"title":"","company":"","period":""}],"education":[{"school":"","degree":"","field":"","year":""}],"skills":[],"bio":"","notableAchievements":[],"location":"","linkedinHeadline":"","linkedinUrl":"","interests":[],"talkingPoints":[]}. Only facts about THIS person. No speculation. Return ONLY the JSON.`,
          searchContext,
          { temperature: 0.1, maxTokens: 600 },
        );
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const profile = JSON.parse(jsonMatch[0]);
          profile.sources = _collectedSources.slice(0, 8);
          _saveToCache(person, profile);
          return profile;
        }
      }
    } catch (e2) {
      console.warn('Fallback enrichment also failed:', e2);
    }

    const emptyProfile = { previousRoles: [], education: [], skills: [], bio: '', notableAchievements: [], location: '', linkedinHeadline: '', linkedinUrl: '', interests: [], talkingPoints: [], sources: [] };
    _saveToCache(person, emptyProfile);
    return emptyProfile;
  }

  // ─── Public: Enrich multiple people (batch) ───
  async function enrichBatch(people, onProgress) {
    const results = [];
    for (let i = 0; i < people.length; i++) {
      try {
        const profile = await enrichPerson(people[i]);
        results.push({ person: people[i], profile });
      } catch (e) {
        console.warn(`Failed to enrich ${people[i].f} ${people[i].l}:`, e);
        results.push({ person: people[i], profile: null, error: e.message });
      }
      if (onProgress) onProgress(i + 1, people.length);
    }
    return results;
  }

  // ─── Public: Format enrichment for chat display ───
  function formatProfileHtml(person, profile) {
    if (!profile) return '<em>No background info found.</em>';

    const parts = [];

    if (profile.bio) {
      parts.push(`<div class="enrich-bio">${_esc(profile.bio)}</div>`);
    }

    if (profile.previousRoles && profile.previousRoles.length > 0) {
      const roles = profile.previousRoles.map(r =>
        `<div class="enrich-role-item">
          <strong>${_esc(r.title)}</strong> at ${_esc(r.company)}${r.period ? ` <span class="enrich-period">(${_esc(r.period)})</span>` : ''}
        </div>`
      ).join('');
      parts.push(`<div class="enrich-section"><div class="enrich-section-title">Previous Roles</div>${roles}</div>`);
    }

    if (profile.education && profile.education.length > 0) {
      const edu = profile.education.map(e =>
        `<div class="enrich-edu-item">
          <strong>${_esc(e.school)}</strong>${e.degree ? ` — ${_esc(e.degree)}` : ''}${e.field ? ` in ${_esc(e.field)}` : ''}${e.year ? ` <span class="enrich-period">(${_esc(e.year)})</span>` : ''}
        </div>`
      ).join('');
      parts.push(`<div class="enrich-section"><div class="enrich-section-title">Education</div>${edu}</div>`);
    }

    if (profile.skills && profile.skills.length > 0) {
      const skills = profile.skills.map(s => `<span class="enrich-skill">${_esc(s)}</span>`).join('');
      parts.push(`<div class="enrich-section"><div class="enrich-section-title">Skills</div><div class="enrich-skills">${skills}</div></div>`);
    }

    if (profile.notableAchievements && profile.notableAchievements.length > 0) {
      const achievements = profile.notableAchievements.map(a => `<li>${_esc(a)}</li>`).join('');
      parts.push(`<div class="enrich-section"><div class="enrich-section-title">Notable</div><ul class="enrich-achievements">${achievements}</ul></div>`);
    }

    if (profile.location) {
      parts.push(`<div class="enrich-location">📍 ${_esc(profile.location)}</div>`);
    }

    return parts.join('');
  }

  function _esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Validate Tavily Key ───
  async function validateKey(key) {
    try {
      const res = await fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query: 'test',
          search_depth: 'basic',
          max_results: 1,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
  }

  // ═══════════════════════════════════════════
  // OUTBOUND PEOPLE DISCOVERY
  // Search the web for people matching a vague query
  // ═══════════════════════════════════════════

  /**
   * Fallback discovery — direct Tavily search + AI extraction.
   * Used when tool calling fails or returns no results.
   */
  /**
   * Heavy parallel discovery — generates many search queries with AI,
   * fires them ALL at Tavily simultaneously, then extracts people.
   * Can handle 50-100+ results.
   */
  async function _parallelDiscovery(query, targetCount = 50, onProgress, extractionHint = '') {
    // Check if query already contains pre-split search queries (one per line)
    const preSplitQueries = query.split('\n').map(q => q.trim()).filter(q => q.length > 5);
    const hasPreSplit = preSplitQueries.length >= 3 && preSplitQueries.every(q => q.length < 100);

    let searchQueries;
    if (hasPreSplit) {
      // Already have specific queries from _splitSearchIntent — use them directly
      // Plus generate variations (different title synonyms per firm)
      const numExtra = Math.max(0, Math.min(20, targetCount / 3) - preSplitQueries.length);
      searchQueries = [...preSplitQueries];

      if (numExtra > 0) {
        try {
          const variationContext = extractionHint
            ? `\nCONTEXT:${extractionHint}\n\nExisting queries:\n${preSplitQueries.join('\n')}`
            : preSplitQueries.join('\n');
          const { text: extraText } = await AIProvider.aiCall(
            `Given these existing LinkedIn search queries, generate ${Math.ceil(numExtra)} MORE queries that target the SAME firms but with DIFFERENT title variations or synonyms. Use site:linkedin.com. Keep the same specificity level. Return ONLY a JSON array.`,
            variationContext,
            { temperature: 0.4, maxTokens: 800 },
          );
          const m = extraText.match(/\[[\s\S]*\]/);
          if (m) searchQueries.push(...JSON.parse(m[0]));
        } catch { /* use what we have */ }
      }
    } else {
      // Generate queries from scratch
      const numQueries = Math.min(Math.max(Math.ceil(targetCount / 3), 8), 30);
      const queryContext = extractionHint
        ? `${extractionHint}\n\nUser request:\n${query}`
        : query;
      const { text: queryText } = await AIProvider.aiCall(
        `You generate web search queries to find real professionals. Create ${numQueries} diverse search queries.

RULES:
- Each query should find DIFFERENT people (vary job titles, companies, regions, seniority levels)
- Use site:linkedin.com in most queries to find actual LinkedIn profiles
- Use SPECIFIC company names and job titles — do NOT generalize
- If context above lists target firms and titles, use those EXACT firms and titles in your queries
- If context above lists exclusions, do NOT generate queries for excluded firms
- Return a JSON array of strings. ONLY the JSON array.`,
        queryContext,
        { temperature: 0.5, maxTokens: 1500 },
      );

      try {
        const m = queryText.match(/\[[\s\S]*\]/);
        searchQueries = m ? JSON.parse(m[0]) : [];
      } catch {
        searchQueries = [];
      }

      if (searchQueries.length < 3) {
        searchQueries = [
          `${query} LinkedIn`,
          `${query} site:linkedin.com`,
          `${query} professionals directory`,
        ];
      }
    }

    console.log(`Parallel discovery: firing ${searchQueries.length} searches for "${query}"`);
    if (onProgress) onProgress('searching', 0, 0);

    // Step 2: Fire ALL searches in parallel
    const searchPromises = searchQueries.map(async (sq, i) => {
      _searchCount++;
      if (_onSearchProgress) _onSearchProgress(_searchCount, sq);
      try {
        return await _tavilySearch(sq, 'advanced', 20);
      } catch {
        try { return await _tavilySearch(sq, 'basic', 10); }
        catch { return []; }
      }
    });

    const allSearchResults = await Promise.all(searchPromises);
    const allResults = allSearchResults.flat();

    console.log(`Parallel discovery: got ${allResults.length} raw results`);

    if (!allResults.length) return [];

    // Deduplicate by URL
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    console.log(`Parallel discovery: ${unique.length} unique URLs`);
    if (onProgress) onProgress('extracting', 0, 0);

    // Step 3: Extract people — split into chunks if too much content
    const CHUNK_SIZE = 40; // process 40 search results at a time
    const chunks = [];
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      chunks.push(unique.slice(i, i + CHUNK_SIZE));
    }

    // Process chunks in parallel
    const extractionPromises = chunks.map(async (chunk) => {
      const context = chunk.map(r => `[${r.title}] (${r.url})\n${r.content}`).join('\n\n---\n\n');
      try {
        const hintBlock = extractionHint || `\n- Only people relevant to: "${query.slice(0, 200)}"`;
        const { text } = await AIProvider.aiCall(
          `Extract ONLY people who match ALL of these criteria from the search results. Be strict — skip anyone who doesn't clearly match.
${hintBlock}

Return a JSON array:
[{"name":"Full Name","title":"Job Title","company":"Company","linkedin":"URL or empty","context":"Why they match","source":"URL"}]

Rules:
- Full first AND last name required (skip "John S." or initials)
- SKIP people who don't match the criteria above — do NOT extract everyone
- LinkedIn URLs only (linkedin.com/in/...) — skip other URLs
- Return ONLY the JSON array`,
          context,
          { temperature: 0.1, maxTokens: 4000 },
        );
        const m = text.match(/\[[\s\S]*\]/);
        return m ? JSON.parse(m[0]) : [];
      } catch (e) {
        console.warn('Extraction chunk failed:', e);
        return [];
      }
    });

    const extractedChunks = await Promise.all(extractionPromises);
    const allPeople = extractedChunks.flat();

    // Deduplicate by name
    const nameSet = new Set();
    return allPeople.filter(p => {
      if (!p.name) return false;
      const key = p.name.toLowerCase().trim();
      if (nameSet.has(key)) return false;
      nameSet.add(key);
      return true;
    });
  }

  async function _fallbackDiscovery(query, targetCount = 15) {
    const isLarge = targetCount > 20;
    const numQueries = isLarge ? 12 : 6;

    // Ask AI to generate search queries — more for large searches
    const { text: queryText } = await AIProvider.aiCall(
      `Extract the core search intent from this user message and return ${numQueries} specific web search queries as a JSON array of strings. Include "LinkedIn" or "site:linkedin.com" in most queries. Also include queries for staff directories or team pages. Use varied job titles, synonyms, and sub-categories to maximize coverage. Be specific with job titles and organizations. Return ONLY the JSON array.`,
      query,
      { temperature: 0.3, maxTokens: 500 },
    );

    let searchQueries;
    try {
      const m = queryText.match(/\[[\s\S]*\]/);
      searchQueries = m ? JSON.parse(m[0]) : [`${query} LinkedIn professionals`];
    } catch {
      searchQueries = [`${query} LinkedIn professionals`];
    }

    // Run ALL searches in parallel
    const queriesToRun = searchQueries.slice(0, numQueries);
    const searchPromises = queriesToRun.map(async (sq) => {
      try {
        return await _tavilySearch(sq, 'advanced', isLarge ? 20 : 10);
      } catch (e) {
        console.warn(`Advanced search "${sq}" failed, trying basic:`, e);
        try {
          return await _tavilySearch(sq, 'basic', 5);
        } catch (e2) {
          console.warn(`Basic search "${sq}" also failed:`, e2);
          return [];
        }
      }
    });

    const searchResults = await Promise.all(searchPromises);
    const allResults = searchResults.flat();

    if (!allResults.length) return [];

    // Deduplicate by URL
    const seen = new Set();
    const unique = allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });

    // Extract people with AI — higher token limit for large searches
    const context = unique.map(r => `[${r.title}] (${r.url})\n${r.content}`).join('\n\n---\n\n');
    const { text: extractText } = await AIProvider.aiCall(
      `Extract people from these search results who are relevant to: "${query.slice(0, 300)}". Be strict — only include people who clearly match.

Return a JSON array: [{"name":"Full Name","title":"Job Title","company":"Company","linkedin":"linkedin.com URL or empty","context":"Why relevant","source":"URL"}]

Rules: Full first AND last name required. Skip anyone without a clear match to the search criteria. Return ONLY the JSON array.`,
      context,
      { temperature: 0.1, maxTokens: isLarge ? 8000 : 3000 },
    );

    try {
      const m = extractText.match(/\[[\s\S]*\]/);
      return m ? JSON.parse(m[0]) : [];
    } catch { return []; }
  }

  /**
   * Main discovery function — searches the web for people matching a query.
   * Uses AI tool calling to let the model decide what and how to search.
   * Returns { people: [...], query, searchCount }
   */
  async function discoverPeople(query, onProgress, targetCount = 15, extractionHint = '') {
    if (!_tavilyKey) throw new Error('Tavily API key not configured');
    if (!AIProvider.getProvider()) throw new Error('AI provider not configured');

    _searchCount = 0;
    if (onProgress) onProgress('searching', 0, 0);

    // For large searches (20+), skip tool calling entirely and go straight to
    // parallel Tavily blitz — much faster and more results
    if (targetCount > 20) {
      let people = await _parallelDiscovery(query, targetCount, onProgress, extractionHint);
      const nameSet = new Set();
      const uniquePeople = people.filter(p => {
        if (!p.name) return false;
        const key = p.name.toLowerCase().trim();
        if (nameSet.has(key)) return false;
        nameSet.add(key);
        return true;
      });
      return { people: uniquePeople, query, searchCount: 'parallel' };
    }

    // Normal search: AI-driven tool calling
    const hintSection = extractionHint
      ? `\nSEARCH CONTEXT:${extractionHint}\n\nUse the target firms and titles above to craft your search queries. Do NOT search for excluded firms or titles.\n`
      : '';
    const systemPrompt = `You find real professionals by searching the web. You are excellent at crafting precise LinkedIn search queries.
${hintSection}
Use the web_search tool to find people. Make 4-5 searches. Each search MUST use search_depth "advanced" and max_results 10.

SEARCH STRATEGY — craft queries that find ACTUAL PEOPLE, not articles:
- Use site:linkedin.com in at least 3 queries
- Use specific job titles, not vague terms
- Include company/organization names when relevant
- If the query contains multiple lines, each line is a separate search query — use them as-is
- Example good queries:
  - "COO Investment Banking Houlihan Lokey site:linkedin.com"
  - "Chief Data Officer Lazard site:linkedin.com"
  - "Head of AI Strategy Evercore site:linkedin.com"
- Example BAD queries (too vague, finds articles not people):
  - "people in AI banking"
  - "management consultants AI"
  - "investment banking technology" (finds articles, not people)

After searching, return a JSON array of people found:
[{"name":"Full Name","title":"Job Title","company":"Company","linkedin":"LinkedIn URL or empty","context":"Why relevant","source":"Source URL"}]

Rules:
- Full first AND last name required. Skip "John S." or initials.
- Deduplicate by name
- Return ONLY the JSON array`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, query, {
        temperature: 0.3,
        maxTokens: 2000,
        useTools: true,
      });

      if (onProgress) onProgress('extracting', 0, 0);

      const match = text.match(/\[[\s\S]*\]/);
      let people = [];
      if (match) {
        try {
          people = JSON.parse(match[0]);
        } catch (parseErr) {
          console.warn('Failed to parse discovery JSON:', parseErr);
        }
      }

      // If tool calling returned no people, fall back to parallel search
      if (!people.length) {
        console.log('Tool-based discovery returned 0 people, trying parallel fallback...');
        people = await _parallelDiscovery(query, targetCount, onProgress);
      }

      // Deduplicate by name
      const nameSet = new Set();
      const uniquePeople = people.filter(p => {
        if (!p.name) return false;
        const key = p.name.toLowerCase().trim();
        if (nameSet.has(key)) return false;
        nameSet.add(key);
        return true;
      });

      return {
        people: uniquePeople,
        query,
        searchCount: 'auto',
      };
    } catch (e) {
      console.warn('Tool-based discovery failed, trying fallback:', e);
      // Fallback: direct search without tool calling
      try {
        const people = await _fallbackDiscovery(query);
        return { people, query, searchCount: 'fallback' };
      } catch (e2) {
        console.warn('Fallback discovery also failed:', e2);
        return { people: [], query, searchCount: 0 };
      }
    }
  }

  return {
    configure, getKey, isConfigured,
    enrichPerson, enrichBatch,
    getCached, clearCache,
    formatProfileHtml,
    validateKey,
    discoverPeople,
    setSearchProgressCallback, resetSearchCount,
  };
})();
