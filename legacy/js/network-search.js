/**
 * Network Search — local keyword-based search that finds relevant people
 * without needing an AI call. Works as instant fallback and for simple queries.
 *
 * When AI is connected, this is used to pre-filter candidates before sending
 * to the LLM, dramatically reducing token usage.
 */

const NetworkSearch = (() => {

  /**
   * Search for people matching a natural language query.
   * Returns scored results with a "why" explanation.
   * @param {string} query - e.g., "I'm building a fintech app and need investors"
   * @param {Array} data - full people array
   * @param {number} limit - max results
   * @returns {Array<{person, score, why}>}
   */
  function search(query, data, limit = 10) {
    const q = query.toLowerCase();
    const tokens = q.split(/\s+/).filter(t => t.length > 2);

    // Detect intent from query
    const intent = detectIntent(q);

    const scored = data.map(p => {
      let score = 0;
      const reasons = [];
      const fullText = `${p.f} ${p.l} ${p.p || ''} ${p.c || ''} ${p.e || ''}`.toLowerCase();

      // Direct keyword matches
      for (const token of tokens) {
        if (fullText.includes(token)) {
          score += 10;
          // Bonus for name match
          if (`${p.f} ${p.l}`.toLowerCase().includes(token)) score += 15;
          // Bonus for company match
          if ((p.c || '').toLowerCase().includes(token)) {
            score += 8;
            reasons.push(`Works at ${p.c}`);
          }
          // Bonus for position match
          if ((p.p || '').toLowerCase().includes(token)) {
            score += 12;
          }
        }
      }

      // Intent-based scoring
      if (intent.needsInvestors && p._cat === 'investor_vc') {
        score += 40;
        reasons.push('Investor/VC');
      }
      if (intent.needsFounders && p._cat === 'founder_ceo') {
        score += 35;
        reasons.push('Founder/CEO');
      }
      if (intent.needsEngineers && p._cat === 'product_eng') {
        score += 35;
        reasons.push('Product/Engineering');
      }
      if (intent.needsSales && p._cat === 'sales_growth') {
        score += 35;
        reasons.push('Sales/Growth');
      }
      if (intent.needsExecs && p._cat === 'exec_leader') {
        score += 30;
        reasons.push('Executive/Leader');
      }
      if (intent.needsResearch && p._cat === 'research_acad') {
        score += 30;
        reasons.push('Researcher/Academic');
      }
      if (intent.needsOps && p._cat === 'ops_strategy') {
        score += 30;
        reasons.push('Operations/Strategy');
      }

      // Industry matching from intent
      if (intent.industries.length > 0) {
        for (const ind of intent.industries) {
          if ((p._industry || '').toLowerCase().includes(ind)) {
            score += 20;
            reasons.push(`${p._industry} industry`);
            break;
          }
          // Also check company/position text
          if (fullText.includes(ind)) {
            score += 12;
          }
        }
      }

      // Email bonus (more actionable)
      if (p.e && score > 0) {
        score += 8;
        reasons.push('Has email');
      }

      // Discovery score bonus
      const ds = window.discoveryScore ? window.discoveryScore(p) : 0;
      score += ds * 0.3;

      // Build "why" string
      const position = p.p ? `${p.p}` : '';
      const company = p.c ? ` at ${p.c}` : '';
      let why = reasons.length > 0 ? reasons.slice(0, 2).join(' · ') : '';
      if (!why && position) why = position;

      return { person: p, score, why };
    });

    return scored
      .filter(r => r.score > 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Detect user intent from query text.
   */
  function detectIntent(q) {
    return {
      needsInvestors: /\b(invest|vc|funding|raise|capital|angel|seed|series)\b/.test(q),
      needsFounders: /\b(founder|ceo|startup|entrepreneur|cofounder|co-founder|build|launch)\b/.test(q),
      needsEngineers: /\b(engineer|developer|technical|cto|coding|software|ml|ai|data|backend|frontend|dev)\b/.test(q),
      needsSales: /\b(sales|marketing|growth|gtm|go.to.market|revenue|customers|distribution|bd|business dev)\b/.test(q),
      needsExecs: /\b(exec|leader|director|vp|head of|c-suite|management|senior)\b/.test(q),
      needsResearch: /\b(research|academic|professor|phd|scientist|paper|publish)\b/.test(q),
      needsOps: /\b(operat|strategy|consult|project|program|analyst|ops)\b/.test(q),
      industries: extractIndustries(q),
    };
  }

  /**
   * Extract industry keywords from query.
   */
  function extractIndustries(q) {
    const map = {
      'ai': 'ai', 'artificial intelligence': 'ai', 'machine learning': 'ai', 'ml': 'ai',
      'fintech': 'fintech', 'financial': 'fintech', 'banking': 'fintech', 'payment': 'fintech',
      'health': 'health', 'biotech': 'biotech', 'medical': 'health', 'pharma': 'health',
      'climate': 'climate', 'energy': 'energy', 'sustainability': 'climate', 'green': 'climate',
      'robotics': 'robot', 'hardware': 'hardware', 'space': 'space',
      'consumer': 'consumer', 'retail': 'retail', 'ecommerce': 'consumer', 'e-commerce': 'consumer',
      'media': 'media', 'creative': 'creative', 'content': 'media',
      'travel': 'travel', 'hospitality': 'hospitality',
      'saas': 'software', 'software': 'software', 'developer': 'software',
      'crypto': 'fintech', 'blockchain': 'fintech', 'web3': 'fintech',
    };

    const found = [];
    for (const [keyword, industry] of Object.entries(map)) {
      if (q.includes(keyword) && !found.includes(industry)) {
        found.push(industry);
      }
    }
    return found;
  }

  /**
   * Build a compact context string for AI from search results.
   * This pre-filters people so the LLM gets only relevant candidates,
   * saving ~80% of tokens vs sending the full network.
   */
  function buildAIContext(query, data, limit = 30) {
    const results = search(query, data, limit);
    if (results.length === 0) return '';

    return results.map(r => {
      const p = r.person;
      return `${p.f} ${p.l}|${p.p || ''}|${p.c || ''}|${p._cat}|${p._industry || ''}${p.e ? '|' + p.e : ''}`;
    }).join('\n');
  }

  return { search, detectIntent, buildAIContext };
})();
