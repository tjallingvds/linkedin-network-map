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
    const lastDiscovery = ChatState.getLastDiscovery();
    const lastBatch = ChatState.getLastBatchResults();
    const lastQuery = ChatState.getLastQuery();

    if (lastDiscovery) {
      previousContext = `\nPREVIOUS ACTION: Web discovery found ${lastDiscovery.people.length} people for "${lastDiscovery.query}".`;
    } else if (lastBatch) {
      previousContext = `\nPREVIOUS ACTION: Batch enrichment search for "${lastBatch.query}".`;
    } else if (lastQuery) {
      previousContext = `\nPREVIOUS ACTION: Network search for "${lastQuery}".`;
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

6. "followup" — The user is asking a QUESTION about previous results or filtering them (NOT asking for more people). Use when:
   - User says "the rest", "show remaining", "what about the others" (referring to results already found but not yet shown)
   - User asks a question about a previously found person
   - User wants to refine, filter, or understand previous results
   - User asks about contact info of previously shown people (e.g. "which ones have email?", "do any have a phone number?", "who has their email listed?")
   - CRITICAL: If the previous search just returned results and the user asks about those results (filtering, sorting, contact info), this is ALWAYS a followup — do NOT re-run the search
   - Return: { "action": "followup" }

7. "clarify" — You're not confident enough to search effectively. Use when ANY of these apply:
   - The query is very short (1-2 words) and uses abbreviations, slang, or jargon (e.g. "ib", "pe", "vc", "mc", "mbb") — ALWAYS clarify these even if you think you know what they mean, because abbreviations can mean different things
   - No specific companies, job titles, or industries are mentioned (e.g. "find me consultants", "people in tech", "AI people")
   - The query is ambiguous — it could mean multiple very different types of people
   - Missing key constraints that would make results useful: no geography, no seniority level, no firm size/type
   - You're less than 80% confident you understand the exact person profile being requested
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
