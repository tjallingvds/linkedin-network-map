/**
 * Chat module — lets users ask natural language questions about their network.
 *
 * TWO MODES:
 * 1. Local search (no AI) — instant keyword matching, shows person cards
 * 2. AI chat (with API key) — two-step: first decompose the query,
 *    then search with structured filters, then have AI rank & explain.
 *
 * The AI sees a FOCUSED subset (~30 people) pre-filtered by the decomposed intent.
 */

const Chat = (() => {
  let _messages = _loadMessages(); // { role, content }
  let _networkStats = '';
  let _allData = [];

  function _saveMessages() {
    try {
      // Only save last 50 messages to avoid localStorage bloat
      const toSave = _messages.slice(-50);
      localStorage.setItem('chat_messages', JSON.stringify(toSave));
    } catch (e) { console.warn('Failed to save chat messages:', e); }
  }

  function _loadMessages() {
    try {
      const saved = localStorage.getItem('chat_messages');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  }

  function _pushMessage(role, content) {
    _messages.push({ role, content });
    _saveMessages();
  }

  /**
   * Build a lightweight network stats summary (~200 tokens).
   */
  function buildNetworkSummary(data) {
    _allData = data;
    const cats = {};
    const companies = {};
    const industries = {};

    data.forEach(p => {
      cats[p._cat] = (cats[p._cat] || 0) + 1;
      if (p.c) companies[p.c] = (companies[p.c] || 0) + 1;
      if (p._industry) industries[p._industry] = (industries[p._industry] || 0) + 1;
    });

    const topCompanies = Object.entries(companies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');

    const topIndustries = Object.entries(industries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');

    const catSummary = Object.entries(cats)
      .map(([key, count]) => `${Categorizer.CATEGORIES[key]?.label || key}: ${count}`)
      .join(', ');

    _networkStats = `NETWORK: ${data.length} connections
CATEGORIES: ${catSummary}
TOP COMPANIES: ${topCompanies}
INDUSTRIES: ${topIndustries}`;

    return _networkStats;
  }

  /**
   * Step 1: Ask AI to decompose the user's query into structured filters.
   * This is a cheap call (~100 tokens out) that tells us WHAT to search for.
   */
  async function _decomposeQuery(userMessage) {
    const systemPrompt = `You decompose a user's networking request into structured search filters.
Given a query about someone's LinkedIn network, output a JSON object with these fields:

{
  "roles": [],           // which role categories to look for: "founder_ceo", "investor_vc", "exec_leader", "product_eng", "sales_growth", "ops_strategy", "research_acad"
  "industries": [],      // industry keywords: "ai", "fintech", "climate", "health", "software", "consumer", etc.
  "keywords": [],        // specific keywords to match in position/company (e.g. "YC", "Series A", "machine learning")
  "intent": "",          // one line: what the user actually needs (e.g. "find investors for climate startup")
  "searchStrategy": ""   // "role" if role matters most, "industry" if industry matters, "keyword" if specific terms, "broad" if general
}

Be precise. If user says "I'm building a fintech startup and need fundraising help", roles should be ["investor_vc", "founder_ceo"] (investors to pitch, founders who've raised), industries ["fintech"], keywords ["fundraising", "seed", "series"].

If user says "who works in AI?", roles should be [], industries ["ai"], keywords ["artificial intelligence", "machine learning"], searchStrategy "industry".

If user asks about a specific person by name, set keywords to their name parts and searchStrategy to "keyword".

Respond ONLY with the JSON object. No explanation.`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, userMessage, {
        temperature: 0.1,
        maxTokens: 200,
        json: AIProvider.getProvider() !== 'claude',
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('Query decomposition failed, using local search:', e);
    }

    return null; // fallback to local keyword search
  }

  /**
   * Step 2: Use decomposed filters to find relevant people.
   * Much better than raw keyword matching.
   */
  function _structuredSearch(filters, limit = 30) {
    const scored = _allData.map(p => {
      let score = 0;
      const reasons = [];
      const fullText = `${p.f} ${p.l} ${p.p || ''} ${p.c || ''} ${p.e || ''}`.toLowerCase();

      // Role match (strongest signal)
      if (filters.roles && filters.roles.length > 0) {
        if (filters.roles.includes(p._cat)) {
          score += 40;
          reasons.push(Categorizer.CATEGORIES[p._cat]?.short || p._cat);
        }
      }

      // Industry match
      if (filters.industries && filters.industries.length > 0) {
        for (const ind of filters.industries) {
          const indLower = ind.toLowerCase();
          if ((p._industry || '').toLowerCase().includes(indLower)) {
            score += 25;
            reasons.push(p._industry);
            break;
          }
          if (fullText.includes(indLower)) {
            score += 15;
            break;
          }
        }
      }

      // Keyword match
      if (filters.keywords && filters.keywords.length > 0) {
        for (const kw of filters.keywords) {
          if (fullText.includes(kw.toLowerCase())) {
            score += 20;
            // Bonus for position/company match vs just name match
            if ((p.p || '').toLowerCase().includes(kw.toLowerCase())) score += 10;
            if ((p.c || '').toLowerCase().includes(kw.toLowerCase())) score += 8;
          }
        }
      }

      // Has email = more actionable
      if (p.e && score > 0) score += 5;

      // Discovery score bonus
      const ds = window.discoveryScore ? window.discoveryScore(p) : 0;
      score += ds * 0.2;

      return { person: p, score, reasons };
    });

    return scored
      .filter(r => r.score > 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Build context string for AI from structured search results.
   */
  function _buildContext(results) {
    if (!results.length) return '';
    return results.map(r => {
      const p = r.person;
      return `${p.f} ${p.l}|${p.p || '?'}|${p.c || '?'}|${Categorizer.CATEGORIES[p._cat]?.short || p._cat}|${p._industry || '?'}${p.e ? '|' + p.e : ''}`;
    }).join('\n');
  }

  /**
   * Step 3: Have AI rank and explain the filtered candidates.
   */
  function _getSystemPrompt(candidateContext, filters) {
    const intent = filters?.intent || 'find relevant people';
    return `You help a user explore their LinkedIn network. You have ${_allData.length} of their connections loaded with only basic info: name, job title, company, and category.

USER'S INTENT: ${intent}

YOUR JOB:
- List the most relevant people from the CANDIDATES below.
- Format names as **FirstName LastName** (exact match from list).
- For each: state their ACTUAL title and company. That's all you know — don't infer anything else.
- If someone has an email listed, include it.

WHAT YOU DON'T KNOW:
- You don't know if these people are available, interested, or good fits beyond their title.
- You don't know their skills, personality, or relationship to the user.
- Don't pretend otherwise. Don't say "could be open to a new venture" or "experienced in fundraising" — you have no basis for that.

STYLE:
- Just list people with their real info. Short. No fluff.
- No outreach templates. No generic advice. No disclaimers.
- If matches are weak, say so in one line.
- If no candidates match, just say "No matches in your network. Try asking me to search on the internet."
- NEVER say "I cannot browse the internet" — you CAN search the web if the user asks.
- CRITICAL: Only use **bold** for actual person names (first + last name). NEVER bold phrases, sentences, or instructions like "no matches" or "search on the internet".

${_networkStats}

CANDIDATES (name|title|company|category|industry|email):
${candidateContext || 'No matching candidates found.'}`;
  }


  // Callback for progress updates
  let _onEnrichProgress = null;
  let _onDiscoveryProgress = null;
  function setEnrichProgressCallback(fn) { _onEnrichProgress = fn; }
  function setDiscoveryProgressCallback(fn) { _onDiscoveryProgress = fn; }

  // Last results for follow-up context
  let _lastDiscoveryResults = null;
  let _lastBatchResults = null;
  let _lastQuery = null; // tracks the last meaningful search query



  /**
   * Route the user's message to the right handler using AI classification.
   * The AI decides: network search, web discovery, enrichment, or batch enrichment.
   */
  async function send(userMessage) {
    _pushMessage('user', userMessage);

    // Step 0: Quick keyword check for obvious web search intent (skip classifier)
    const msgLower = userMessage.toLowerCase();
    const webKeywords = /\b(on the internet|search the internet|on the web|search online|find online|search the web|find them online|look online|find it online|discover online|web search)\b/i;
    if (webKeywords.test(userMessage) && Enricher.isConfigured()) {
      // Resolve the actual query from context
      const searchTopic = _lastQuery || userMessage;
      const resolvedQuery = msgLower.includes('them') || msgLower.includes('it') || msgLower.length < 30
        ? searchTopic
        : userMessage;
      return _handleDiscovery(resolvedQuery, userMessage, 15);
    }

    // Step 1: Quick AI classification of intent
    const route = await _classifyIntent(userMessage);

    if (route.action === 'clarify' && route.question) {
      const text = route.question;
      _pushMessage('assistant', text);
      return { text, tokensUsed: 0 };
    }

    if (route.action === 'followup') {
      return _handleFollowup(userMessage);
    }

    if (route.action === 'discover_more' && _lastDiscoveryResults) {
      if (!Enricher.isConfigured()) return _handleNormalSearch(userMessage);
      // Search again with the same topic but ask for different results
      const moreQuery = _lastDiscoveryResults.query + ' (find different people, not: ' +
        _lastDiscoveryResults.people.slice(0, 10).map(p => p.name).join(', ') + ')';
      const targetCount = route.count || 15;
      return _handleDiscovery(moreQuery, userMessage, targetCount);
    }

    if (route.action === 'enrich' && route.person) {
      const person = _matchPersonByName(route.person);
      if (person) return _handleSingleEnrichment(person, userMessage);
    }

    if (route.action === 'batch_enrich' && route.query) {
      return _handleBatchEnrichment({ type: route.type || 'background', query: route.query }, userMessage);
    }

    if (route.action === 'discover') {
      if (!Enricher.isConfigured()) {
        // Fall through to network search if no web search configured
        return _handleNormalSearch(userMessage);
      }
      // Use the classifier's resolved query if available (handles "find it online" → actual topic)
      const discoveryQuery = route.query || userMessage;
      const targetCount = route.count || 15;
      return _handleDiscovery(discoveryQuery, userMessage, targetCount);
    }

    // Default: search the local network
    return _handleNormalSearch(userMessage);
  }

  /**
   * AI-powered intent classifier. One cheap call to decide routing.
   * Returns { action, person?, query?, type? }
   */
  async function _classifyIntent(userMessage) {
    const hasWebSearch = Enricher.isConfigured();
    const networkSize = _allData.length;

    // Build conversation context so classifier understands references
    const recentConvo = _messages.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n');

    let previousContext = '';
    if (_lastDiscoveryResults) {
      previousContext = `\nPREVIOUS ACTION: Web discovery found ${_lastDiscoveryResults.people.length} people for "${_lastDiscoveryResults.query}".`;
    } else if (_lastBatchResults) {
      previousContext = `\nPREVIOUS ACTION: Batch enrichment search for "${_lastBatchResults.query}".`;
    } else if (_lastQuery) {
      previousContext = `\nPREVIOUS ACTION: Network search for "${_lastQuery}".`;
    }

    const systemPrompt = `You classify a user's networking query into one of these actions. The user has a local LinkedIn network of ${networkSize} connections loaded (with name, current title, current company). ${hasWebSearch ? 'Web search is also available.' : 'Web search is NOT available — only local network.'}
${previousContext}

RECENT CONVERSATION:
${recentConvo || '(none)'}

CURRENT MESSAGE: "${userMessage}"

Return a JSON object with "action" and optional fields:

1. "network" — Search the LOCAL network. Use this for:
   - Questions about their existing connections ("who do I know in fintech?", "find investors in my network")
   - Asking about people at specific companies they might know
   - ANY query that could be answered from current job titles and companies

2. "discover" — Search the WEB for new people not in the network. Use when:
   - User explicitly says "search the web/internet", "find new people", "discover", "search online", "find it online", "look online"
   - User is clearly looking for people OUTSIDE their network
   - The query asks for people at SPECIFIC COMPANIES the user is unlikely to know personally (e.g. "find people at JPMorgan doing AI")
   - The query is a detailed research/prospecting brief with target companies, role archetypes, or specific criteria
   - The query mentions multiple specific organizations or banks to search across
   - CRITICAL: If the user says something like "find it online" or "search online" AFTER a previous query, they want to REPEAT THE PREVIOUS SEARCH but on the web. In that case, set query to the topic from the previous search, NOT the literal words "find it online".
   - If the user specifies a number (e.g. "find 50 people", "give me 100"), include "count" in the response
   - For detailed prospecting briefs with many target companies, default count to 50+
   - Return: { "action": "discover", "query": "the actual search topic", "count": 15 }
   - Default count is 15. Set higher for detailed briefs (50+) or if user explicitly asks (e.g. "find 50", "find 100", "a lot", "as many as possible" = 50)
   ${!hasWebSearch ? '- NOT AVAILABLE (no web search configured) — use "network" instead' : ''}

3. "enrich" — Look up detailed background of a specific person. Use when:
   - User names a specific person and wants to know more ("tell me about John Smith", "what's Sarah's background?")
   - User says "enrich person X", "enrich John Smith", "prep for call with X", "research X"
   - Return: { "action": "enrich", "person": "Full Name" }

4. "batch_enrich" — Search backgrounds of network connections for hidden links. Use when:
   - User asks about previous employers, education, or history ("who went to Stanford?", "anyone ex-McKinsey?")
   - Return: { "action": "batch_enrich", "query": "Stanford", "type": "education" or "previous_company" or "background" }

5. "discover_more" — The user wants MORE people from a previous web discovery. Use when:
   - User says "find more", "more people", "find additional", "keep searching" AFTER a web discovery
   - This triggers a NEW web search for the same topic
   - Return: { "action": "discover_more" }

6. "followup" — The user is asking a QUESTION about previous results (NOT asking for more). Use when:
   - User says "the rest", "show remaining", "what about the others" (referring to results already found but not yet shown)
   - User asks a question about a previously found person
   - User wants to refine, filter, or understand previous results
   - Return: { "action": "followup" }

7. "clarify" — You're not confident enough to search effectively. Use when ANY of these apply:
   - No specific companies, job titles, or industries are mentioned (e.g. "find me consultants", "people in tech", "AI people")
   - The query is ambiguous — it could mean multiple very different types of people
   - Missing key constraints that would make results useful: no geography, no seniority level, no firm size/type
   - You're less than 80% confident you understand the exact person profile being requested
   - Return: { "action": "clarify", "question": "A specific clarifying question" }
   - Ask ONE focused question that would most improve search quality. Suggest concrete options.
   - Examples:
     "find me consultants" → { "action": "clarify", "question": "What type of consulting? (e.g. management, IT, strategy) And any target firms or industries?" }
     "I need people in AI" → { "action": "clarify", "question": "What kind of AI roles? (e.g. AI strategy leaders, ML engineers, AI product managers) And at what type of company?" }
     "help me find leads" → { "action": "clarify", "question": "What kind of leads? What industry, role type, and company size are you targeting?" }
   - Do NOT clarify if the query already has specific firms + specific titles + clear criteria (e.g. a detailed research brief). Those are ready to search.

Respond ONLY with the JSON object.`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, userMessage, {
        temperature: 0.05,
        maxTokens: 200,
        json: AIProvider.getProvider() !== 'claude',
      });

      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      console.warn('Intent classification failed:', e);
    }

    return { action: 'network' };
  }

  /**
   * Match a person name from the AI classifier to actual data.
   */
  function _matchPersonByName(name) {
    if (!name) return null;
    const queryLower = name.toLowerCase().trim();
    return _allData.find(p => {
      const fullName = `${p.f} ${p.l}`.toLowerCase();
      return fullName === queryLower ||
        fullName.includes(queryLower) ||
        queryLower.includes(fullName);
    }) || null;
  }

  /**
   * Normal search flow (unchanged logic).
   */
  async function _handleNormalSearch(userMessage) {
    _lastQuery = userMessage;
    PersonModal.setSearchContext(userMessage);
    const filters = await _decomposeQuery(userMessage);

    let candidateContext;
    if (filters) {
      const results = _structuredSearch(filters, 30);
      candidateContext = _buildContext(results);
    } else {
      candidateContext = NetworkSearch.buildAIContext(userMessage, _allData, 30);
    }

    const recentMessages = _messages.slice(-20);

    try {
      const { text, tokensUsed } = await AIProvider.aiChat(
        _getSystemPrompt(candidateContext, filters),
        recentMessages,
        { temperature: 0.4, maxTokens: 800 }
      );

      _pushMessage('assistant', text);
      return { text, tokensUsed };
    } catch (e) {
      const errMsg = `Sorry, I couldn't process that: ${e.message}`;
      _pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Handle single-person enrichment — Tavily search + AI summary.
   * Also opens the PersonModal for call-prep view.
   */
  async function _handleSingleEnrichment(person, userMessage) {
    try {
      // Open modal immediately (shows loading state, fetches in background)
      const cached = Enricher.getCached(person);
      PersonModal.show(person, cached);

      const profile = cached || await Enricher.enrichPerson(person);
      // Update modal with full profile if it was fetched fresh
      if (!cached && profile) PersonModal.show(person, profile);

      const enrichContext = profile ? JSON.stringify(profile, null, 2) : 'No additional background found.';

      const systemPrompt = `You present enriched background information about a LinkedIn connection.

The user asked about **${person.f} ${person.l}** (currently: ${person.p || 'Unknown'} at ${person.c || 'Unknown'}).

Below is their background info gathered from web search. Present it in a clear, organized way:
- Start with a one-line summary of who they are
- List previous roles (if any) with company and time period
- List education (if any)
- Mention notable skills or achievements
- Format names as **FirstName LastName**

If data is sparse, say so briefly. Don't invent information.

BACKGROUND DATA:
${enrichContext}`;

      const recentMessages = _messages.slice(-20);
      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 800 }
      );

      _pushMessage('assistant', text);
      return { text, tokensUsed, enriched: true, person, profile };
    } catch (e) {
      const errMsg = `Couldn't enrich ${person.f} ${person.l}: ${e.message}`;
      _pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Handle batch enrichment — find candidates, enrich them, filter by background.
   * e.g. "who worked at McKinsey?" or "anyone from Stanford?"
   */
  async function _handleBatchEnrichment(batchRequest, userMessage) {
    const { type, query } = batchRequest;

    try {
      // Step 1: First check if any current data already matches (company/position)
      const queryLower = query.toLowerCase();
      const directMatches = _allData.filter(p => {
        const text = `${p.c || ''} ${p.p || ''}`.toLowerCase();
        return text.includes(queryLower);
      });

      // Step 2: Pick candidates to enrich — people in related industries/roles
      // who might have a hidden connection to the query
      let candidates = _pickEnrichmentCandidates(query, type);

      // Cap at 8 to avoid burning too many Tavily credits
      const MAX_ENRICH = 8;
      candidates = candidates.slice(0, MAX_ENRICH);

      if (candidates.length === 0 && directMatches.length === 0) {
        const text = `I couldn't find anyone obviously connected to "${query}" in your network. The CSV only has current role and company — with more connections, a broader search might help.`;
        _pushMessage('assistant', text);
        return { text, tokensUsed: 0 };
      }

      // Step 3: Enrich candidates via Tavily (with progress)
      const enrichedResults = [];
      let enrichedCount = 0;

      if (candidates.length > 0) {
        if (_onEnrichProgress) _onEnrichProgress('start', 0, candidates.length, query);

        for (const person of candidates) {
          try {
            const profile = await Enricher.enrichPerson(person);
            if (profile) {
              enrichedResults.push({ person, profile });
            }
          } catch (e) {
            console.warn(`Enrich failed for ${person.f} ${person.l}:`, e);
          }
          enrichedCount++;
          if (_onEnrichProgress) _onEnrichProgress('progress', enrichedCount, candidates.length, query);
        }

        if (_onEnrichProgress) _onEnrichProgress('done', enrichedCount, candidates.length, query);
      }

      // Step 4: Filter enriched results for actual matches
      const matches = _filterEnrichedByQuery(enrichedResults, query, type);

      // Step 5: Have AI compile the answer
      const systemPrompt = _buildBatchEnrichmentPrompt(query, type, directMatches, matches);
      const recentMessages = _messages.slice(-20);

      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 1024 }
      );

      _pushMessage('assistant', text);

      // Return all matched profiles for UI cards
      const allMatchedProfiles = matches.map(m => ({ person: m.person, profile: m.profile }));

      // Store for follow-up context
      _lastBatchResults = { results: allMatchedProfiles, directMatches, query };
      _lastDiscoveryResults = null;

      return {
        text, tokensUsed,
        batchEnriched: true,
        results: allMatchedProfiles,
        directMatches,
        query,
      };
    } catch (e) {
      const errMsg = `Error searching backgrounds: ${e.message}`;
      _pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Smart discovery: split long queries into sub-queries, short ones go direct.
   * Deduplicates across sub-queries and accumulates until targetCount is met.
   */
  // Full brief text for the current search (used by filter for exclusion rules)
  let _currentBrief = null;

  /**
   * Handle outbound people discovery — search the web for people.
   */
  async function _handleDiscovery(query, userMessage, targetCount = 15, extractionHint = '') {
    PersonModal.setSearchContext(query);
    try {
      // Cross-reference function for marking network connections
      const isInNetwork = (name) => {
        if (!name) return null;
        const nameLower = name.toLowerCase().trim();
        const nameParts = nameLower.split(/\s+/).filter(w => w.length > 1);
        if (nameParts.length < 2) return null; // need first + last

        return _allData.find(p => {
          const first = (p.f || '').toLowerCase();
          const last = (p.l || '').toLowerCase();
          const fullName = `${first} ${last}`;

          // Exact full name match
          if (fullName === nameLower) return true;

          // First + last name both present in the discovered name
          // (handles "Dr. John Smith" matching "John Smith")
          if (nameParts.includes(first) && nameParts.includes(last)) return true;

          return false;
        });
      };

      const result = await Enricher.discoverPeople(query, (status, done, total) => {
        if (_onDiscoveryProgress) _onDiscoveryProgress(status, done, total, query);
      }, targetCount, extractionHint);

      if (!result.people.length) {
        const text = `I searched the web but couldn't find specific people to recommend. Try being more specific — e.g. "find founders doing AI in climate tech" or "CTOs at fintech startups in London".`;
        _pushMessage('assistant', text);
        return { text, tokensUsed: 0 };
      }

      // AI relevance filter — dedupe and remove clearly irrelevant results
      const filteredPeople = await _filterDiscoveryResults(result.people, query);

      // Mark people who are in the network
      const people = filteredPeople.map(p => ({
        ...p,
        inNetwork: isInNetwork(p.name),
      }));

      if (!people.length) {
        const text = `Searched the web but didn't find anyone clearly relevant. Try being more specific.`;
        _pushMessage('assistant', text);
        return { text, tokensUsed: 0 };
      }

      // Short summary — cards do the real work
      const peopleContext = people.map(p =>
        `- ${p.name} — ${p.title} at ${p.company}${p.inNetwork ? ' [IN YOUR NETWORK]' : ''}${p.context ? ' (' + p.context + ')' : ''}`
      ).join('\n');

      const networkCount = people.filter(p => p.inNetwork).length;
      const networkNote = networkCount > 0 ? ` (${networkCount} in your network)` : '';
      const text = `Found ${people.length} people${networkNote}.`;
      const tokensUsed = 0;

      _pushMessage('assistant', text + '\n' + peopleContext);

      // Store for follow-up context — accumulate if same topic
      const baseQuery = query.replace(/\s*\(find different people.*?\)\s*$/, '');
      if (_lastDiscoveryResults && _lastDiscoveryResults.query === baseQuery) {
        // Append new people, deduplicate by name
        const existingNames = new Set(_lastDiscoveryResults.people.map(p => p.name?.toLowerCase()));
        const newPeople = people.filter(p => !existingNames.has(p.name?.toLowerCase()));
        _lastDiscoveryResults.people = [..._lastDiscoveryResults.people, ...newPeople];
        _lastDiscoveryResults.peopleContext = _lastDiscoveryResults.people.map(p =>
          `- ${p.name} — ${p.title} at ${p.company}${p.inNetwork ? ' [IN YOUR NETWORK]' : ''}${p.context ? ' (' + p.context + ')' : ''}`
        ).join('\n');
      } else {
        _lastDiscoveryResults = { people, query: baseQuery, peopleContext };
      }
      _lastBatchResults = null;

      return {
        text, tokensUsed,
        discovered: true,
        people,
        query,
      };
    } catch (e) {
      const errMsg = `Discovery failed: ${e.message}`;
      _pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * AI-powered filter: deduplicate and remove irrelevant discovery results.
   * Runs a cheap AI call to score relevance and filter out noise.
   */
  async function _filterDiscoveryResults(people, query) {
    if (!people.length || people.length <= 3) return people;

    // Step 1: Deduplicate by normalized name
    const seen = new Set();
    const deduped = people.filter(p => {
      if (!p.name) return false;
      const key = p.name.toLowerCase().trim().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Step 2: Remove obviously bad entries (no real name, placeholder titles)
    const cleaned = deduped.filter(p => {
      const name = (p.name || '').trim();
      // Must have first + last name
      if (!name.includes(' ')) return false;
      if (name.length < 4) return false;
      // Skip placeholder names
      if (/^(not specified|unknown|n\/a|company representative|author)/i.test(name)) return false;
      if (/^(not specified|unknown|n\/a)/i.test(p.title || '')) return false;
      return true;
    });

    // Step 3: Hard exclusion filter — removes excluded firms/titles with exact matching (no AI)
    let filtered = cleaned;
    if (_parsedBrief) {
      const exFirms = (_parsedBrief.excludeFirms || []).map(f => f.toLowerCase());
      const exTitles = (_parsedBrief.excludeTitles || []).map(t => t.toLowerCase());
      const exSeniority = (_parsedBrief.excludeSeniority || []).map(s => s.toLowerCase());

      // Build word sets for fuzzy company matching (handles "GS" vs "Goldman Sachs")
      const exFirmWords = exFirms.map(f => f.split(/[\s,&]+/).filter(w => w.length > 2));

      const companyMatchesExcluded = (company) => {
        if (!company) return false;
        const c = company.toLowerCase();
        // Direct substring match
        if (exFirms.some(ef => c.includes(ef) || ef.includes(c))) return true;
        // Word overlap — if 2+ significant words from an excluded firm appear in the company name
        return exFirmWords.some(words => {
          const matches = words.filter(w => c.includes(w));
          return matches.length >= 2 || (words.length === 1 && matches.length === 1);
        });
      };

      filtered = cleaned.filter(p => {
        const company = (p.company || '').toLowerCase();
        const title = (p.title || '').toLowerCase();

        // Exclude if company matches an excluded firm
        if (companyMatchesExcluded(p.company)) return false;

        // Exclude if title contains an excluded seniority level
        if (exSeniority.some(es => title.includes(es))) return false;

        // Exclude if title matches an excluded title pattern
        if (exTitles.some(et => title.includes(et))) return false;

        return true;
      });

      console.log(`Hard filter: ${cleaned.length} → ${filtered.length} (removed ${cleaned.length - filtered.length} excluded)`);
    }

    // Step 4: If small enough set after hard filter, skip AI call
    if (filtered.length <= 8) return filtered;

    // Step 5: AI relevance scoring for remaining candidates
    try {
      const listText = filtered.map((p, i) =>
        `${i}: ${p.name} — ${p.title || '?'} at ${p.company || '?'}`
      ).join('\n');

      // Build concise exclusion context from parsed brief (not the full 2000-char blob)
      let filterRules = '';
      if (_parsedBrief) {
        filterRules = `\n\nFILTER RULES:`;
        if (_parsedBrief.context) filterRules += `\nLooking for: ${_parsedBrief.context}`;
        if (_parsedBrief.firms?.length) filterRules += `\nTarget firms: ${_parsedBrief.firms.join(', ')}`;
        if (_parsedBrief.titles?.length) filterRules += `\nTarget titles: ${_parsedBrief.titles.slice(0, 8).join(', ')}`;
      }

      const { text } = await AIProvider.aiCall(
        `You filter search results strictly. Return a JSON array of INDEX NUMBERS to KEEP.

REMOVE: duplicates, fake names, people clearly unrelated to the search.${filterRules}

People:
${listText}

Return ONLY a JSON array of index numbers, e.g. [0, 2, 5, 7]`,
        'Filter these results.',
        { temperature: 0.05, maxTokens: 500 },
      );

      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const indices = JSON.parse(match[0]);
        return indices
          .filter(i => typeof i === 'number' && i >= 0 && i < filtered.length)
          .map(i => filtered[i]);
      }
    } catch (e) {
      console.warn('AI filter failed, using hard-filtered results:', e);
    }

    return filtered;
  }

  /**
   * Handle follow-up questions about previous discovery/enrichment results.
   * Injects the previous results as context so the AI can answer coherently.
   */
  async function _handleFollowup(userMessage) {
    let contextBlock = '';

    if (_lastDiscoveryResults) {
      contextBlock = `PREVIOUS WEB DISCOVERY for "${_lastDiscoveryResults.query}":\n` +
        _lastDiscoveryResults.people.map(p =>
          `- ${p.name} — ${p.title || '?'} at ${p.company || '?'}${p.linkedin ? ' [LinkedIn: ' + p.linkedin + ']' : ''}${p.context ? ' (' + p.context + ')' : ''}`
        ).join('\n');
    } else if (_lastBatchResults) {
      contextBlock = `PREVIOUS BATCH ENRICHMENT for "${_lastBatchResults.query}":\n`;
      if (_lastBatchResults.directMatches?.length) {
        contextBlock += 'Currently there:\n' + _lastBatchResults.directMatches.slice(0, 15).map(p =>
          `- ${p.f} ${p.l} — ${p.p || '?'} at ${p.c || '?'}${p.e ? ' (' + p.e + ')' : ''}`
        ).join('\n') + '\n';
      }
      if (_lastBatchResults.results?.length) {
        contextBlock += 'Found via background search:\n' + _lastBatchResults.results.map(({ person }) =>
          `- ${person.f} ${person.l} — ${person.p || '?'} at ${person.c || '?'}${person.e ? ' (' + person.e + ')' : ''}`
        ).join('\n');
      }
    }

    if (!contextBlock) {
      // No previous results — treat as normal search
      return _handleNormalSearch(userMessage);
    }

    const systemPrompt = `You help a user with follow-up questions about previously found people.

The user previously searched and got results. They're now asking a follow-up. Answer based on the data below. Format names as **FirstName LastName**.

If they ask for "more" or "the rest", present the people from the previous results that weren't yet discussed in the conversation. If they ask about a specific person from the results, give their details.

${contextBlock}

STYLE:
- Format names as **Full Name** so they become clickable
- Be concise and directly answer the follow-up
- Don't re-introduce yourself or the search — just answer
- If the data doesn't contain what they need, say so briefly`;

    const recentMessages = _messages.slice(-20);

    try {
      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 1000 }
      );

      _pushMessage('assistant', text);
      return { text, tokensUsed };
    } catch (e) {
      const errMsg = `Follow-up failed: ${e.message}`;
      _pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Pick the best candidates to enrich for a given query.
   * Uses industry/role heuristics to avoid enriching random people.
   */
  function _pickEnrichmentCandidates(query, type) {
    const queryLower = query.toLowerCase();

    // Known industry/consulting/school keywords for smarter candidate selection
    const isConsulting = /\b(mckinsey|bain|bcg|deloitte|pwc|ey|kpmg|accenture|oliver wyman|strategy&)\b/i.test(query);
    const isTech = /\b(google|meta|facebook|apple|amazon|microsoft|netflix|uber|airbnb|stripe|palantir|nvidia)\b/i.test(query);
    const isFinance = /\b(goldman|jpmorgan|morgan stanley|citi|barclays|blackrock|bridgewater|citadel|two sigma)\b/i.test(query);
    const isSchool = type === 'education' || /\b(university|college|school|institute|stanford|harvard|oxford|cambridge|mit|yale|princeton|wharton|insead|lbs|hbs)\b/i.test(query);
    const isVC = /\b(sequoia|a16z|andreessen|accel|benchmark|greylock|index|lakestar|seedcamp|yc|y combinator)\b/i.test(query);

    // Score each person on how likely they are to have a background connection
    const scored = _allData.map(p => {
      let score = 0;
      const currentText = `${p.c || ''} ${p.p || ''}`.toLowerCase();

      // Skip people who currently work there (they're direct matches, not hidden)
      if (currentText.includes(queryLower)) return { person: p, score: -1 };

      // Already cached? Prioritize — free lookup
      if (Enricher.getCached(p)) score += 50;

      // Industry affinity scoring
      if (isConsulting && (p._industry === 'Consulting & Professional Services' || p._cat === 'ops_strategy' || p._cat === 'exec_leader')) score += 30;
      if (isTech && (p._industry === 'Big Tech' || p._industry === 'Software & Developer Tools' || p._cat === 'product_eng')) score += 30;
      if (isFinance && (p._industry === 'Fintech & Financial Services' || p._cat === 'investor_vc')) score += 30;
      if (isSchool && (p._industry === 'Startups & Accelerators' || p._cat === 'research_acad')) score += 25;
      if (isVC && (p._cat === 'investor_vc' || p._cat === 'founder_ceo')) score += 30;

      // Founder/exec more likely to have interesting backgrounds
      if (p._cat === 'founder_ceo') score += 15;
      if (p._cat === 'exec_leader') score += 10;
      if (p._cat === 'investor_vc') score += 8;

      // Higher discovery score = more interesting
      const ds = window.discoveryScore ? window.discoveryScore(p) : 0;
      score += ds * 0.3;

      return { person: p, score };
    });

    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(r => r.person);
  }

  /**
   * Filter enriched results by whether their background matches the query.
   */
  function _filterEnrichedByQuery(enrichedResults, query, type) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    return enrichedResults.filter(({ profile }) => {
      if (!profile) return false;

      const matchesText = (text) => {
        if (!text) return false;
        const t = text.toLowerCase();
        return t.includes(queryLower) || queryWords.some(w => t.includes(w));
      };

      // Check previous roles
      if (profile.previousRoles?.some(r => matchesText(r.company) || matchesText(r.title))) return true;

      // Check education
      if (profile.education?.some(e => matchesText(e.school) || matchesText(e.field) || matchesText(e.degree))) return true;

      // Check bio
      if (matchesText(profile.bio)) return true;

      // Check achievements
      if (profile.notableAchievements?.some(a => matchesText(a))) return true;

      return false;
    });
  }

  /**
   * Build the AI prompt for batch enrichment results.
   */
  function _buildBatchEnrichmentPrompt(query, type, directMatches, enrichedMatches) {
    let context = `You help a user discover hidden connections in their LinkedIn network.\n\n`;
    context += `USER'S QUESTION: Looking for people connected to "${query}"\n\n`;

    // Direct matches (currently at the company/school)
    if (directMatches.length > 0) {
      context += `CURRENTLY AT ${query.toUpperCase()} (from CSV):\n`;
      directMatches.slice(0, 10).forEach(p => {
        context += `- **${p.f} ${p.l}** — ${p.p || '?'} at ${p.c || '?'}${p.e ? ' (' + p.e + ')' : ''}\n`;
      });
      context += '\n';
    }

    // Enriched matches (found via web search)
    if (enrichedMatches.length > 0) {
      context += `PREVIOUSLY AT / CONNECTED TO ${query.toUpperCase()} (found via background search):\n`;
      enrichedMatches.forEach(({ person, profile }) => {
        const p = person;
        context += `- **${p.f} ${p.l}** — currently ${p.p || '?'} at ${p.c || '?'}\n`;

        // Show the matching background detail
        if (profile.previousRoles?.length) {
          const relevant = profile.previousRoles.filter(r => {
            const t = `${r.company} ${r.title}`.toLowerCase();
            return t.includes(query.toLowerCase());
          });
          if (relevant.length) {
            relevant.forEach(r => {
              context += `  ↳ Previously: ${r.title} at ${r.company}${r.period ? ' (' + r.period + ')' : ''}\n`;
            });
          }
        }
        if (profile.education?.length) {
          const relevant = profile.education.filter(e => {
            const t = `${e.school} ${e.field || ''} ${e.degree || ''}`.toLowerCase();
            return t.includes(query.toLowerCase());
          });
          if (relevant.length) {
            relevant.forEach(e => {
              context += `  ↳ Education: ${e.school}${e.degree ? ' — ' + e.degree : ''}${e.field ? ' in ' + e.field : ''}${e.year ? ' (' + e.year + ')' : ''}\n`;
            });
          }
        }
        if (p.e) context += `  ↳ Email: ${p.e}\n`;
      });
      context += '\n';
    }

    if (directMatches.length === 0 && enrichedMatches.length === 0) {
      context += `No matches found for "${query}" — neither in current roles nor in backgrounds searched.\n`;
    }

    context += `\nSTYLE:
- List all matches clearly, grouped by "Currently there" vs "Previously there"
- Format names as **FirstName LastName** so they become clickable
- Show the relevant background detail (previous role or education)
- Keep it concise — just the facts
- If we found hidden connections, highlight that these weren't visible from the CSV alone
- Note: I searched ${enrichedMatches.length > 0 ? 'the backgrounds of likely candidates' : 'but found no background matches'} using web search`;

    return context;
  }

  /**
   * Local search — no AI needed. Returns person cards.
   */
  function localSearch(query) {
    return NetworkSearch.search(query, _allData, 8);
  }

  function clearHistory() { _messages = []; _saveMessages(); }
  function getMessages() { return _messages; }
  function getData() { return _allData; }

  /**
   * Parse assistant response — convert **Name** to clickable chips.
   * In-network names open the PersonModal. Discovery names link to LinkedIn if available.
   */
  function formatResponse(text, data) {
    // Collect discovered people for matching
    const discoveredPeople = _lastDiscoveryResults?.people || [];

    let html = text.replace(/\*\*([^*]+)\*\*/g, (match, name) => {
      const nameLower = name.toLowerCase().trim();

      // Check local network first
      const person = data.find(p =>
        `${p.f} ${p.l}`.toLowerCase() === nameLower ||
        `${p.f} ${p.l}`.toLowerCase().includes(nameLower) ||
        nameLower.includes(`${p.f} ${p.l}`.toLowerCase())
      );

      if (person) {
        const cat = Categorizer.CATEGORIES[person._cat];
        const idx = data.indexOf(person);
        return `<span class="person-chip person-chip-enrichable" data-person-idx="${idx}" title="Click to enrich">
          <span class="chip-dot" style="background:${cat.color}"></span>${person.f} ${person.l}
        </span>`;
      }

      // Check discovered people (from web search)
      const discovered = discoveredPeople.find(p =>
        p.name && (p.name.toLowerCase() === nameLower ||
        p.name.toLowerCase().includes(nameLower) ||
        nameLower.includes(p.name.toLowerCase()))
      );

      if (discovered) {
        const linkedinUrl = discovered.linkedin || '';
        return `<span class="person-chip person-chip-discovered" ${linkedinUrl ? `data-url="${linkedinUrl}"` : ''} title="${discovered.title || ''} at ${discovered.company || ''}">
          <span class="chip-dot" style="background:var(--text3)"></span>${name}
        </span>`;
      }

      return `<strong>${name}</strong>`;
    });

    // Don't convert \n to <br> here — let _formatMarkdown handle structure
    return html;
  }

  /**
   * Parse a research brief into structured search parameters.
   * One focused AI call — extracts firms, titles, exclusions as JSON.
   */
  async function _parseBrief(brief) {
    try {
      const { text } = await AIProvider.aiCall(
        `You extract structured search parameters from a research brief. Return a JSON object with:

{
  "firms": ["Company1", "Company2", ...],        // target companies to search
  "titles": ["COO", "Chief Data Officer", ...],    // SHORT searchable title keywords (highest priority first)
  "excludeFirms": ["Goldman Sachs", "JPMorgan", ...],  // companies to EXCLUDE — include common name variations (e.g. both "JPMorgan" and "J.P. Morgan")
  "excludeTitles": ["title pattern", ...],        // title patterns to exclude
  "excludeSeniority": ["Analyst", "Associate"],   // seniority levels to exclude
  "geography": ["US", "UK", ...],                 // target regions
  "context": "1-2 sentence summary of what kind of person we're looking for"
}

Rules:
- Extract the EXACT company names mentioned as targets
- For titles, extract the SHORT searchable keyword (e.g. "COO", "Chief Data Officer", "CTO", "Head of AI") — NOT the full verbose title like "COO of Investment Banking Division"
- List titles in priority order (Tier 1 first, then Tier 2, etc.)
- Extract ALL explicit exclusions (companies, titles, seniority levels)
- For excludeFirms: include ALL name variations (e.g. "JPMorgan", "J.P. Morgan", "JPMorgan Chase", "Morgan Stanley", "Goldman Sachs", "Bank of America", "Barclays", etc.)
- Be thorough — capture every firm and every title variant mentioned

Return ONLY the JSON object.`,
        brief,
        { temperature: 0.1, maxTokens: 1500 }
      );
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      console.warn('Brief parsing failed:', e);
    }
    return null;
  }

  /**
   * Build Tavily search queries programmatically from parsed brief.
   * No AI involved — just firm × title combinations.
   */
  function _buildSearchQueries(parsed, targetCount) {
    const queries = [];
    const firms = parsed.firms || [];
    const titles = parsed.titles || [];

    // Shorten long titles to key terms for better search results
    // "COO of Investment Banking" → "COO" , "Chief Data Officer" → "Chief Data Officer"
    const shortTitle = (t) => {
      // Extract the core title (before "of", "at", "-", etc.)
      return t.replace(/\s+(of|at|for|in|-|–|,)\s+.*/i, '').trim();
    };

    // Strategy: one query per firm with the top 2-3 title keywords
    // site:linkedin.com constrains to actual LinkedIn profiles
    const topTitles = titles.slice(0, 3).map(shortTitle);
    const titleKeywords = topTitles.join(' OR ');

    for (const firm of firms) {
      // Primary: firm + top titles on LinkedIn
      queries.push(`${firm} ${titleKeywords} site:linkedin.com`);
    }

    // Also run title-focused queries without specific firms for broader reach
    for (const title of titles.slice(0, 5)) {
      const short = shortTitle(title);
      queries.push(`${short} investment bank site:linkedin.com`);
    }

    // Cap at 30 queries max to stay within Tavily rate limits
    return queries.slice(0, 30);
  }

  /**
   * Direct discovery from a research brief.
   * Parses the brief into structured params, builds queries programmatically,
   * and injects exclusion rules into extraction and filtering.
   */
  async function discover(query, targetCount) {
    _currentBrief = query;
    PersonModal.setSearchContext(query);

    // Parse the brief into structured search params
    const parsed = await _parseBrief(query);

    if (parsed && parsed.firms?.length > 0) {
      // Build search queries from structured data — no AI query generation
      const searchQueries = _buildSearchQueries(parsed, targetCount);

      // Store parsed brief for extraction and filter prompts
      _parsedBrief = parsed;

      // Build extraction hint — concise rules for every downstream AI prompt
      let hint = '';
      if (parsed.context) hint += `\n- GOAL: ${parsed.context}`;
      hint += `\n- ONLY extract people at these target firms: ${parsed.firms.join(', ')}`;
      if (parsed.titles?.length) hint += `\n- ONLY extract people with titles like: ${parsed.titles.slice(0, 6).join(', ')}`;
      if (parsed.excludeFirms?.length) hint += `\n- EXCLUDE anyone at: ${parsed.excludeFirms.join(', ')}`;
      if (parsed.excludeTitles?.length) hint += `\n- EXCLUDE titles containing: ${parsed.excludeTitles.join(', ')}`;
      if (parsed.excludeSeniority?.length) hint += `\n- EXCLUDE seniority levels: ${parsed.excludeSeniority.join(', ')}`;
      if (parsed.geography?.length) hint += `\n- GEOGRAPHY priority: ${parsed.geography.join(', ')}`;

      // Pass queries to discovery as newline-separated list
      const combinedQuery = searchQueries.join('\n');
      return _handleDiscovery(combinedQuery, query, targetCount, hint);
    }

    // Fallback: short/simple query, just pass through
    _parsedBrief = null;
    return _handleDiscovery(query, query, targetCount);
  }

  let _parsedBrief = null;

  return {
    buildNetworkSummary,
    send,
    discover,
    localSearch,
    clearHistory,
    getMessages,
    getData,
    formatResponse,
    setEnrichProgressCallback,
    setDiscoveryProgressCallback,
  };
})();
