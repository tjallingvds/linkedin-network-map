/**
 * ChatRouter — AI-powered intent classification and person name matching.
 *
 * Pure classification: reads state but never mutates it.
 * Returns { action, person?, query?, type?, count?, question? }
 */

const ChatRouter = (() => {

  /**
   * Classify user intent using a single cheap AI call.
   * Returns routing info for the main send() dispatcher.
   */
  async function classifyIntent(userMessage) {
    const hasWebSearch = Enricher.isConfigured();
    const allData = ChatState.getAllData();
    const networkSize = allData.length;

    const recentConvo = ChatState.getMessages().slice(-6)
      .map(m => `${m.role}: ${m.content.slice(0, 150)}`).join('\n');

    let previousContext = '';
    const currentTable = ChatState.getCurrentTable();
    const lastEnrichment = ChatState.getLastEnrichment();
    const lastDiscovery = ChatState.getLastDiscovery();
    const lastBatch = ChatState.getLastBatchResults();
    const lastQuery = ChatState.getLastQuery();

    if (currentTable) {
      previousContext = `\nPREVIOUS ACTION: A spreadsheet of ${currentTable.rows.length} people is currently loaded with columns [${currentTable.headers.join(', ')}]. ANY request to find/add/lookup/verify info about these people (e.g. "find emails", "add LinkedIn URLs", "verify their titles", "fill in missing data", "what are their phone numbers") MUST be classified as "enrich_table". Use clarify only if the user clearly is NOT asking about the table.`;
    } else if (lastEnrichment?.person) {
      const p = lastEnrichment.person;
      previousContext = `\nPREVIOUS ACTION: Just researched ${p.f} ${p.l} (${p.p || 'unknown role'}${p.c ? ' at ' + p.c : ''}). Detailed profile is in memory. Treat any follow-up question or pronoun ("him", "her", "they", "this person", "the guy", etc.) as referring to ${p.f} ${p.l}.`;
    } else if (lastDiscovery) {
      previousContext = `\nPREVIOUS ACTION: Web discovery found ${lastDiscovery.people.length} people for "${lastDiscovery.query}".`;
    } else if (lastBatch) {
      previousContext = `\nPREVIOUS ACTION: Batch enrichment search for "${lastBatch.query}".`;
    } else if (lastQuery) {
      previousContext = `\nPREVIOUS ACTION: Network search for "${lastQuery}".`;
    }

    // Detect if the last assistant message was a clarification — bias strongly toward searching
    const recentMsgs = ChatState.getMessages();
    const lastAssistant = [...recentMsgs].reverse().find(m => m.role === 'assistant');
    const justClarified = lastAssistant && !lastAssistant.content.trim().startsWith('{');

    const systemPrompt = `You classify a user's networking query into one of these actions. The user has a local LinkedIn network of ${networkSize} connections loaded (with name, current title, current company). ${hasWebSearch ? 'Web search is also available.' : 'Web search is NOT available — only local network.'}
${previousContext}

RECENT CONVERSATION:
${recentConvo || '(none)'}

CURRENT MESSAGE: "${userMessage}"
${justClarified ? '\nIMPORTANT: You just asked a clarifying question and the user has responded. Strongly prefer searching now — use their answer combined with the conversation context. Only clarify again if the response is truly incomprehensible. Set "query" to a clear description combining the original topic with the user\'s answer (e.g. if they asked about "ib" and said "yes investment banking", query should be "investment banking").' : ''}

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

3. "enrich" — Look up detailed background of a specific NAMED person. Use when:
   - User names a specific person and wants to know more ("tell me about John Smith", "what's Sarah's background?")
   - User says "enrich person X", "enrich John Smith", "prep for call with X", "research X"
   - User pastes info about ONE person and asks to research them (e.g. "Julien Trouillet COO at Macquarie, find out everything")
   - The person can be EITHER in the network OR external — both cases use enrich
   - Return: { "action": "enrich", "person": "Full Name", "company": "Company Name or empty", "title": "Title or empty" }
   - Always extract company and title if mentioned in the query. They're needed for web search if the person isn't in the network.

4. "batch_enrich" — Search backgrounds of network connections for hidden links. Use when:
   - User asks about previous employers, education, or history ("who went to Stanford?", "anyone ex-McKinsey?")
   - Return: { "action": "batch_enrich", "query": "Stanford", "type": "education" or "previous_company" or "background" }

5. "discover_more" — The user wants MORE people from a previous web discovery. Use when:
   - User says "find more", "more people", "find additional", "keep searching" AFTER a web discovery
   - This triggers a NEW web search for the same topic
   - Return: { "action": "discover_more" }

6. "followup" — The user is asking a QUESTION about previous results or filtering them (NOT asking for more people). Use when:
   - User says "the rest", "show remaining", "what about the others" (referring to results already found but not yet shown)
   - User asks a question about a previously found/researched person
   - User wants to refine, filter, or understand previous results
   - User asks about contact info of previously shown people (e.g. "which ones have email?", "do any have a phone number?", "who has their email listed?")
   - User asks for advice / drafting / opinions about a previously researched person ("what should I say to him?", "draft an opener", "best compliment to start an email", "what would you ask him?")
   - The user uses pronouns ("him", "her", "they", "this person", "the guy") that refer to someone from the previous action
   - CRITICAL: If the previous search/enrichment just returned results and the user asks anything related (filtering, sorting, contact info, drafting messages, opinions), this is ALWAYS a followup — do NOT re-run the search and do NOT clarify
   - Return: { "action": "followup" }

8. "enrich_table" — A spreadsheet/table of people is loaded and the user wants to add or fill in columns. Use when:
   - A table is loaded (see PREVIOUS ACTION) AND the user asks to find/add/lookup/verify info about its rows
   - Examples: "find emails", "add their LinkedIn URLs", "what's their current title", "fill in phone numbers", "verify they still work there"
   - Return: { "action": "enrich_table" }
   - Do NOT use this if no table is loaded.

7. "clarify" — You're not confident enough to search effectively. Use SPARINGLY and only when:
   - The query is very short (1-2 words) and uses abbreviations, slang, or jargon (e.g. "ib", "pe", "vc", "mc", "mbb") — clarify these because abbreviations can mean different things
   - The query is truly ambiguous — it could mean multiple very different types of people AND you can't make a reasonable guess
   - IMPORTANT: Do NOT clarify just because the query lacks geography, seniority, or firm size. "Investment banking", "AI people", "consultants" are all searchable queries — just search for them. Only clarify if you genuinely don't know WHAT to search for.
   - NEVER clarify more than once. If the conversation already contains a clarification exchange, ALWAYS search instead.
   - Return: { "action": "clarify", "question": "A specific clarifying question" }
   - Ask ONE focused question that would most improve search quality. Suggest concrete options. If you think you know what the abbreviation means, include that guess in your question.
   - Examples:
     "ib" → { "action": "clarify", "question": "Do you mean investment banking? What specifically — people working in IB, IB coverage groups, or something else?" }
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

      const result = AIJSON.extractObject(text, 'classifyIntent');
      if (result.ok) return result.data;
    } catch (e) {
      console.warn('Intent classification failed:', e);
    }

    return { action: 'network' };
  }

  /**
   * Match a person name from the AI classifier to actual network data.
   */
  function matchPersonByName(name) {
    if (!name) return null;
    const queryLower = name.toLowerCase().trim();
    return ChatState.getAllData().find(p => {
      const fullName = `${p.f} ${p.l}`.toLowerCase();
      return fullName === queryLower ||
        fullName.includes(queryLower) ||
        queryLower.includes(fullName);
    }) || null;
  }

  return { classifyIntent, matchPersonByName };
})();
