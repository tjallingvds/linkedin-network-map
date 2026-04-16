/**
 * ChatSearch — local network search orchestration.
 *
 * Decomposes queries with AI, runs structured search against loaded data,
 * then has AI rank and explain the results.
 */

const ChatSearch = (() => {

  /**
   * Decompose a user query into structured filters using AI.
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

      const result = AIJSON.extractObject(text, 'decomposeQuery');
      if (result.ok) return result.data;
    } catch (e) {
      console.warn('Query decomposition failed, using local search:', e);
    }

    return null;
  }

  /**
   * Structured search: score network connections against decomposed filters.
   */
  function _structuredSearch(filters, limit = 30) {
    const allData = ChatState.getAllData();

    const scored = allData.map(p => {
      let score = 0;
      const reasons = [];
      const fullText = `${p.f} ${p.l} ${p.p || ''} ${p.c || ''} ${p.e || ''}`.toLowerCase();

      if (filters.roles && filters.roles.length > 0) {
        if (filters.roles.includes(p._cat)) {
          score += 40;
          reasons.push(Categorizer.CATEGORIES[p._cat]?.short || p._cat);
        }
      }

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

      if (filters.keywords && filters.keywords.length > 0) {
        for (const kw of filters.keywords) {
          if (fullText.includes(kw.toLowerCase())) {
            score += 20;
            if ((p.p || '').toLowerCase().includes(kw.toLowerCase())) score += 10;
            if ((p.c || '').toLowerCase().includes(kw.toLowerCase())) score += 8;
          }
        }
      }

      if (p.e && score > 0) score += 5;

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
   * Build compact context string for AI from search results.
   */
  function _buildContext(results) {
    if (!results.length) return '';
    return results.map(r => {
      const p = r.person;
      return `${p.f} ${p.l}|${p.p || '?'}|${p.c || '?'}|${Categorizer.CATEGORIES[p._cat]?.short || p._cat}|${p._industry || '?'}${p.e ? '|' + p.e : ''}`;
    }).join('\n');
  }

  /**
   * Build AI system prompt for ranking search results.
   */
  function _getSystemPrompt(candidateContext, filters) {
    const allData = ChatState.getAllData();
    const intent = filters?.intent || 'find relevant people';
    const hasWebSearch = Enricher.isConfigured();
    return `You help a user explore their LinkedIn network of ${allData.length} connections.${hasWebSearch ? ' Web search is also available.' : ''}

USER'S INTENT: ${intent}

You MUST respond with a JSON object. No other text. Choose ONE action:

ACTION "results" — you found matching people in the network:
{"action":"results", "summary":"What you found", "people":[{"name":"First Last","title":"Job Title","company":"Company","relevance":"Why they match","email":"email or null"}], "suggest_web_search":false}

ACTION "no_matches" — no good matches in network, suggest web search:
{"action":"no_matches", "summary":"No strong matches in your network for X.", "people":[], "suggest_web_search":true}

ACTION "suggest_scope" — the query is vague/broad, propose a refined search before running it:
{"action":"suggest_scope", "summary":"Your query is broad — here's what I'd suggest searching for.", "suggestions":["Specific search 1 you'd recommend", "Specific search 2", "Specific search 3"], "message":"I can search for these specific profiles. Which would you like me to look for, or should I search for all of them?"}

ACTION "message" — conversational response (not a search):
{"action":"message", "message":"Your response here"}

DECISION RULES:
- If CANDIDATES below contain strong matches → "results"
- If CANDIDATES are empty or very weak AND ${hasWebSearch ? 'web search is available' : 'no web search'} → "no_matches" with suggest_web_search:${hasWebSearch}
- If the query is vague (no specific firms, roles, or industries) AND could mean very different things → "suggest_scope" with 2-4 concrete suggestions of what to search for
- If the user is asking a conversational question, not searching → "message"
- If matches exist but are weak, return them AND set suggest_web_search:true so the user can optionally search the web too
- For each person in "people": use their EXACT name, title, and company from the CANDIDATES list. Don't infer.
- Return ONLY the JSON object. No markdown, no wrapping.

${ChatState.getNetworkStats()}

CANDIDATES (name|title|company|category|industry|email):
${candidateContext || 'No matching candidates found.'}`;
  }

  /**
   * Main handler for local network search.
   */
  async function handleNormalSearch(userMessage) {
    ChatState.setLastQuery(userMessage);
    PersonModal.setSearchContext(userMessage);
    const filters = await _decomposeQuery(userMessage);

    let candidateContext;
    if (filters) {
      const results = _structuredSearch(filters, 30);
      candidateContext = _buildContext(results);
    } else {
      candidateContext = NetworkSearch.buildAIContext(userMessage, ChatState.getAllData(), 30);
    }

    const recentMessages = ChatState.getMessages().slice(-20);

    try {
      let parsed = null;
      let text = '';
      let tokensUsed = 0;

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await AIProvider.aiChat(
          _getSystemPrompt(candidateContext, filters),
          recentMessages,
          { temperature: attempt === 0 ? 0.3 : 0.1, maxTokens: 1200 }
        );
        text = result.text;
        tokensUsed = result.tokensUsed;

        const jsonResult = AIJSON.extractObject(text, 'normalSearch');
        if (jsonResult.ok && jsonResult.data.action) {
          parsed = jsonResult.data;
          break;
        }
        console.warn(`JSON parse attempt ${attempt + 1} failed, retrying...`);
      }

      if (parsed && parsed.action) {
        ChatState.pushMessage('assistant', text);

        const allData = ChatState.getAllData();
        const matchedPeople = (parsed.people || []).map(p => {
          const networkPerson = allData.find(np => {
            const full = `${np.f} ${np.l}`.toLowerCase();
            return full === (p.name || '').toLowerCase();
          });
          return { ...p, _networkPerson: networkPerson || null };
        });

        return {
          text: parsed.summary || '',
          tokensUsed,
          structured: true,
          action: parsed.action,
          people: matchedPeople,
          suggestWebSearch: parsed.suggest_web_search || false,
          message: parsed.message || '',
          suggestions: parsed.suggestions || [],
        };
      }

      ChatState.pushMessage('assistant', text);
      return { text, tokensUsed };
    } catch (e) {
      const errMsg = `Sorry, I couldn't process that: ${e.message}`;
      ChatState.pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  return { handleNormalSearch };
})();
