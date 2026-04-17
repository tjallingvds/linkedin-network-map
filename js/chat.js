/**
 * Chat — thin facade that preserves the public API for chat-ui.js.
 *
 * Routes user messages to the right handler module via ChatRouter,
 * handles follow-up Q&A (cross-cutting), and formats responses.
 */

const Chat = (() => {

  /**
   * Main entry point: classify intent and dispatch to handler.
   */
  async function send(userMessage) {
    ChatState.pushMessage('user', userMessage);

    // If there's a currently loaded table, all messages first try table enrichment
    // unless the user explicitly cancels it. Router still classifies for fallback.
    const route = await ChatRouter.classifyIntent(userMessage);

    if (route.action === 'enrich_table' || (ChatState.getCurrentTable() && route.action === 'enrich_table')) {
      const table = ChatState.getCurrentTable();
      if (table) {
        const result = await ChatTableEnrich.enrichTable(table, userMessage);
        ChatState.pushMessage('assistant', `Enriched table: ${result.intent}`);
        ChatState.setCurrentTable(result); // promote enriched result to be the new active table
        return { tableEnriched: true, ...result };
      }
    }

    if (route.action === 'clarify' && route.question) {
      const text = route.question;
      ChatState.pushMessage('assistant', text);
      return { text, tokensUsed: 0 };
    }

    if (route.action === 'followup') {
      return _handleFollowup(userMessage);
    }

    if (route.action === 'discover_more') {
      const lastDiscovery = ChatState.getLastDiscovery();
      if (lastDiscovery) {
        if (!Enricher.isConfigured()) return ChatSearch.handleNormalSearch(userMessage);
        const moreQuery = lastDiscovery.query + ' (find different people, not: ' +
          lastDiscovery.people.slice(0, 10).map(p => p.name).join(', ') + ')';
        const targetCount = route.count || 15;
        const result = await ChatDiscovery.handleDiscovery(moreQuery, userMessage, targetCount);
        if (result.discovered && result.people?.length) {
          ChatState.setLastDiscovery({ people: result.people, query: result.query });
        }
        return result;
      }
    }

    if (route.action === 'enrich' && route.person) {
      const person = ChatRouter.matchPersonByName(route.person);
      if (person) return ChatEnrich.handleSingleEnrichment(person, userMessage);
      // Person not in network — build a stub from router-extracted info and enrich via web
      if (Enricher.isConfigured()) {
        const nameParts = route.person.split(/\s+/);
        const stub = {
          f: nameParts[0] || '',
          l: nameParts.slice(1).join(' ') || '',
          p: route.title || '',
          c: route.company || '',
          e: '',
          u: '',
          _cat: 'other',
        };
        return ChatEnrich.handleSingleEnrichment(stub, userMessage);
      }
    }

    if (route.action === 'batch_enrich' && route.query) {
      return ChatEnrich.handleBatchEnrichment({ type: route.type || 'background', query: route.query }, userMessage);
    }

    if (route.action === 'discover') {
      if (!Enricher.isConfigured()) {
        return ChatSearch.handleNormalSearch(userMessage);
      }
      const discoveryQuery = route.query || ChatState.getLastQuery() || userMessage;

      if (route.count && route.count > 0) {
        const result = await ChatDiscovery.handleDiscovery(discoveryQuery, userMessage, route.count);
        if (result.discovered && result.people?.length) {
          ChatState.setLastDiscovery({ people: result.people, query: result.query });
        }
        return result;
      }

      ChatState.pushMessage('assistant', JSON.stringify({ action: 'no_matches', summary: 'Ready to search the web.', suggest_web_search: true }));
      return {
        text: 'Ready to search the web.',
        structured: true,
        action: 'no_matches',
        people: [],
        suggestWebSearch: true,
        _webQuery: discoveryQuery,
        tokensUsed: 0,
      };
    }

    return ChatSearch.handleNormalSearch(userMessage);
  }

  /**
   * Handle follow-up questions about previous discovery/enrichment results.
   */
  async function _handleFollowup(userMessage) {
    let contextBlock = '';
    const lastEnrichment = ChatState.getLastEnrichment();
    const lastDiscovery = ChatState.getLastDiscovery();
    const lastBatch = ChatState.getLastBatchResults();
    const lastNetwork = ChatState.getLastNetworkResults();

    // Single enrichment takes priority — it's typically the most recent and detailed context
    if (lastEnrichment?.person) {
      const p = lastEnrichment.person;
      const prof = lastEnrichment.profile || {};
      contextBlock = `PREVIOUSLY RESEARCHED PERSON: ${p.f} ${p.l}\n`;
      contextBlock += `Current role: ${p.p || 'Unknown'}${p.c ? ' at ' + p.c : ''}\n`;
      if (prof.bio) contextBlock += `Bio: ${prof.bio}\n`;
      if (prof.previousRoles?.length) {
        contextBlock += `Previous roles:\n` + prof.previousRoles.map(r =>
          `- ${r.title || '?'} at ${r.company || '?'}${r.period ? ' (' + r.period + ')' : ''}`
        ).join('\n') + '\n';
      }
      if (prof.education?.length) {
        contextBlock += `Education:\n` + prof.education.map(e =>
          `- ${e.school || '?'}${e.degree ? ', ' + e.degree : ''}${e.field ? ' in ' + e.field : ''}${e.year ? ' (' + e.year + ')' : ''}`
        ).join('\n') + '\n';
      }
      if (prof.skills?.length) contextBlock += `Skills: ${prof.skills.join(', ')}\n`;
      if (prof.notableAchievements?.length) {
        contextBlock += `Notable: ${prof.notableAchievements.join('; ')}\n`;
      }
      if (prof.interests?.length) contextBlock += `Interests: ${prof.interests.join(', ')}\n`;
      if (prof.location) contextBlock += `Location: ${prof.location}\n`;
      if (lastEnrichment.text) {
        contextBlock += `\nFull research summary:\n${lastEnrichment.text}\n`;
      }
    } else if (lastDiscovery) {
      contextBlock = `PREVIOUS WEB DISCOVERY for "${lastDiscovery.query}":\n` +
        lastDiscovery.people.map(p =>
          `- ${p.name} — ${p.title || '?'} at ${p.company || '?'}${p.linkedin ? ' [LinkedIn: ' + p.linkedin + ']' : ''}${p.email ? ' [Email: ' + p.email + ']' : ' [No email]'}${p.context ? ' (' + p.context + ')' : ''}`
        ).join('\n');
    } else if (lastNetwork) {
      contextBlock = `PREVIOUS NETWORK SEARCH for "${lastNetwork.query}":\n` +
        lastNetwork.people.map(p => {
          const np = p._networkPerson;
          const email = p.email || np?.e || '';
          const phone = np?.ph || '';
          return `- ${p.name} — ${p.title || '?'} at ${p.company || '?'}${email ? ' [Email: ' + email + ']' : ' [No email]'}${phone ? ' [Phone: ' + phone + ']' : ' [No phone]'}`;
        }).join('\n');
    } else if (lastBatch) {
      contextBlock = `PREVIOUS BATCH ENRICHMENT for "${lastBatch.query}":\n`;
      if (lastBatch.directMatches?.length) {
        contextBlock += 'Currently there:\n' + lastBatch.directMatches.slice(0, 15).map(p =>
          `- ${p.f} ${p.l} — ${p.p || '?'} at ${p.c || '?'}${p.e ? ' (' + p.e + ')' : ''}`
        ).join('\n') + '\n';
      }
      if (lastBatch.results?.length) {
        contextBlock += 'Found via background search:\n' + lastBatch.results.map(({ person }) =>
          `- ${person.f} ${person.l} — ${person.p || '?'} at ${person.c || '?'}${person.e ? ' (' + person.e + ')' : ''}`
        ).join('\n');
      }
    }

    if (!contextBlock) {
      return ChatSearch.handleNormalSearch(userMessage);
    }

    const systemPrompt = `You help a user with follow-up questions about people they previously researched or searched.

The data below contains the most recently relevant context. ALL pronouns in the user's question ("him", "her", "they", "this person", "the guy", "the person") refer to whoever is in the data below — do not ask who they mean.

If the user asks for advice, opinions, drafting (e.g. "what should I say", "best compliment to start an email", "draft an opener", "how should I approach him"), use the background details to give a specific, personalized answer grounded in the actual facts (their roles, education, achievements, interests). Do NOT give generic advice.

If they ask for "more" or "the rest", present the people from the previous results that weren't yet discussed.

IMPORTANT — Filtering/contact questions:
- If the user asks which people have an email, phone number, or other contact info, check the data below carefully. If none of them have that data, just say so directly. Do NOT re-list all the people.
- If some have the info and some don't, only list the ones who have it.

${contextBlock}

STYLE:
- Format names as **Full Name** so they become clickable
- Use clean Markdown structure: ## for sections, ### for subsections, - for bullets, **Label:** value for key facts
- Be concise and directly answer the follow-up — no preamble
- Ground every claim in the data above; never invent
- If suggesting compliments/openers, propose 3-5 specific options each grounded in a unique fact from their background`;

    const recentMessages = ChatState.getMessages().slice(-20);

    try {
      const { text, tokensUsed } = await AIProvider.aiChat(
        systemPrompt,
        recentMessages,
        { temperature: 0.3, maxTokens: 1000 }
      );

      ChatState.pushMessage('assistant', text);
      return { text, tokensUsed };
    } catch (e) {
      const errMsg = `Follow-up failed: ${e.message}`;
      ChatState.pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Parse assistant response — convert **Name** to clickable chips.
   */
  function formatResponse(text, data) {
    const discoveredPeople = ChatState.getLastDiscovery()?.people || [];

    let html = text.replace(/\*\*([^*]+)\*\*/g, (match, name) => {
      const nameLower = name.toLowerCase().trim();

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

    return html;
  }

  // ─── Public API (unchanged shape for chat-ui.js) ───────────

  return {
    buildNetworkSummary: (data) => ChatState.buildNetworkSummary(data),
    send,
    discover: (query, count) => ChatDiscovery.discover(query, count),
    localSearch: (query) => NetworkSearch.search(query, ChatState.getAllData(), 8),
    clearHistory: () => ChatState.clearHistory(),
    getMessages: () => ChatState.getMessages(),
    getLastDiscovery: () => ChatState.getLastDiscovery(),
    setLastDiscovery: (d) => ChatState.setLastDiscovery(d),
    restoreMessages: (msgs) => ChatState.restoreMessages(msgs),
    getData: () => ChatState.getAllData(),
    formatResponse,
    setEnrichProgressCallback: (fn) => ChatEnrich.setEnrichProgressCallback(fn),
    setDiscoveryProgressCallback: (fn) => ChatEnrich.setDiscoveryProgressCallback(fn),
  };
})();
