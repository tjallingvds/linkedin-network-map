/**
 * ChatEnrich — single-person and batch enrichment orchestration.
 *
 * Handles Tavily-based background research, candidate selection,
 * background filtering, and AI-compiled results.
 */

const ChatEnrich = (() => {
  let _onEnrichProgress = null;
  let _onDiscoveryProgress = null;

  function setEnrichProgressCallback(fn) { _onEnrichProgress = fn; }
  function setDiscoveryProgressCallback(fn) { _onDiscoveryProgress = fn; }
  function getDiscoveryProgressCallback() { return _onDiscoveryProgress; }

  /**
   * Enrich a single person — Tavily search + AI summary.
   * Opens PersonModal for call-prep view.
   */
  async function handleSingleEnrichment(person, userMessage) {
    try {
      const cached = Enricher.getCached(person);
      PersonModal.show(person, cached);

      const profile = cached || await Enricher.enrichPerson(person);
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

      const recentMessages = ChatState.getMessages().slice(-20);
      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 800 }
      );

      ChatState.pushMessage('assistant', text);
      return { text, tokensUsed, enriched: true, person, profile };
    } catch (e) {
      const errMsg = `Couldn't enrich ${person.f} ${person.l}: ${e.message}`;
      ChatState.pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Batch enrichment — find candidates, enrich them, filter by background.
   */
  async function handleBatchEnrichment(batchRequest, userMessage) {
    const { type, query } = batchRequest;

    try {
      const allData = ChatState.getAllData();
      const queryLower = query.toLowerCase();
      const directMatches = allData.filter(p => {
        const text = `${p.c || ''} ${p.p || ''}`.toLowerCase();
        return text.includes(queryLower);
      });

      let candidates = _pickEnrichmentCandidates(query, type);
      const MAX_ENRICH = 8;
      candidates = candidates.slice(0, MAX_ENRICH);

      if (candidates.length === 0 && directMatches.length === 0) {
        const text = `I couldn't find anyone obviously connected to "${query}" in your network. The CSV only has current role and company — with more connections, a broader search might help.`;
        ChatState.pushMessage('assistant', text);
        return { text, tokensUsed: 0 };
      }

      const enrichedResults = [];
      let enrichedCount = 0;

      if (candidates.length > 0) {
        if (_onEnrichProgress) _onEnrichProgress('start', 0, candidates.length, query);

        for (const person of candidates) {
          try {
            const profile = await Enricher.enrichPerson(person);
            if (profile) enrichedResults.push({ person, profile });
          } catch (e) {
            console.warn(`Enrich failed for ${person.f} ${person.l}:`, e);
          }
          enrichedCount++;
          if (_onEnrichProgress) _onEnrichProgress('progress', enrichedCount, candidates.length, query);
        }

        if (_onEnrichProgress) _onEnrichProgress('done', enrichedCount, candidates.length, query);
      }

      const matches = _filterEnrichedByQuery(enrichedResults, query, type);
      const systemPrompt = _buildBatchEnrichmentPrompt(query, type, directMatches, matches);
      const recentMessages = ChatState.getMessages().slice(-20);

      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 1024 }
      );

      ChatState.pushMessage('assistant', text);

      const allMatchedProfiles = matches.map(m => ({ person: m.person, profile: m.profile }));
      ChatState.setLastBatchResults({ results: allMatchedProfiles, directMatches, query });
      ChatState.setLastDiscovery(null);

      return {
        text, tokensUsed,
        batchEnriched: true,
        results: allMatchedProfiles,
        directMatches,
        query,
      };
    } catch (e) {
      const errMsg = `Error searching backgrounds: ${e.message}`;
      ChatState.pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Pick best candidates to enrich for a given query.
   */
  function _pickEnrichmentCandidates(query, type) {
    const allData = ChatState.getAllData();
    const queryLower = query.toLowerCase();

    const isConsulting = /\b(mckinsey|bain|bcg|deloitte|pwc|ey|kpmg|accenture|oliver wyman|strategy&)\b/i.test(query);
    const isTech = /\b(google|meta|facebook|apple|amazon|microsoft|netflix|uber|airbnb|stripe|palantir|nvidia)\b/i.test(query);
    const isFinance = /\b(goldman|jpmorgan|morgan stanley|citi|barclays|blackrock|bridgewater|citadel|two sigma)\b/i.test(query);
    const isSchool = type === 'education' || /\b(university|college|school|institute|stanford|harvard|oxford|cambridge|mit|yale|princeton|wharton|insead|lbs|hbs)\b/i.test(query);
    const isVC = /\b(sequoia|a16z|andreessen|accel|benchmark|greylock|index|lakestar|seedcamp|yc|y combinator)\b/i.test(query);

    const scored = allData.map(p => {
      let score = 0;
      const currentText = `${p.c || ''} ${p.p || ''}`.toLowerCase();

      if (currentText.includes(queryLower)) return { person: p, score: -1 };

      if (Enricher.getCached(p)) score += 50;

      if (isConsulting && (p._industry === 'Consulting & Professional Services' || p._cat === 'ops_strategy' || p._cat === 'exec_leader')) score += 30;
      if (isTech && (p._industry === 'Big Tech' || p._industry === 'Software & Developer Tools' || p._cat === 'product_eng')) score += 30;
      if (isFinance && (p._industry === 'Fintech & Financial Services' || p._cat === 'investor_vc')) score += 30;
      if (isSchool && (p._industry === 'Startups & Accelerators' || p._cat === 'research_acad')) score += 25;
      if (isVC && (p._cat === 'investor_vc' || p._cat === 'founder_ceo')) score += 30;

      if (p._cat === 'founder_ceo') score += 15;
      if (p._cat === 'exec_leader') score += 10;
      if (p._cat === 'investor_vc') score += 8;

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

      if (profile.previousRoles?.some(r => matchesText(r.company) || matchesText(r.title))) return true;
      if (profile.education?.some(e => matchesText(e.school) || matchesText(e.field) || matchesText(e.degree))) return true;
      if (matchesText(profile.bio)) return true;
      if (profile.notableAchievements?.some(a => matchesText(a))) return true;

      return false;
    });
  }

  /**
   * Build AI prompt for batch enrichment results.
   */
  function _buildBatchEnrichmentPrompt(query, type, directMatches, enrichedMatches) {
    let context = `You help a user discover hidden connections in their LinkedIn network.\n\n`;
    context += `USER'S QUESTION: Looking for people connected to "${query}"\n\n`;

    if (directMatches.length > 0) {
      context += `CURRENTLY AT ${query.toUpperCase()} (from CSV):\n`;
      directMatches.slice(0, 10).forEach(p => {
        context += `- **${p.f} ${p.l}** — ${p.p || '?'} at ${p.c || '?'}${p.e ? ' (' + p.e + ')' : ''}\n`;
      });
      context += '\n';
    }

    if (enrichedMatches.length > 0) {
      context += `PREVIOUSLY AT / CONNECTED TO ${query.toUpperCase()} (found via background search):\n`;
      enrichedMatches.forEach(({ person, profile }) => {
        const p = person;
        context += `- **${p.f} ${p.l}** — currently ${p.p || '?'} at ${p.c || '?'}\n`;

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

  return {
    handleSingleEnrichment,
    handleBatchEnrichment,
    setEnrichProgressCallback,
    setDiscoveryProgressCallback,
    getDiscoveryProgressCallback,
  };
})();
