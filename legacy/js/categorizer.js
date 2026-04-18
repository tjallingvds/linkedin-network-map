/**
 * AI-powered categorizer — classifies contacts into categories using LLM.
 * Uses batching (50 people per call) and caching to minimize token usage.
 * Falls back to regex if no AI is configured.
 */

const Categorizer = (() => {
  // Cache: keyed by "name|position|company"
  const _cache = {};
  let _aiEnabled = false;

  const CATEGORIES = {
    founder_ceo:   { label: 'Founders & CEOs', color: '#C0785C', short: 'Founder' },
    investor_vc:   { label: 'Investors & VCs', color: '#8B7EC8', short: 'Investor' },
    exec_leader:   { label: 'Execs & Leaders', color: '#3E7B97', short: 'Executive' },
    product_eng:   { label: 'Product & Eng',   color: '#4A8F72', short: 'Product/Eng' },
    sales_growth:  { label: 'Sales & Growth',  color: '#C4953A', short: 'Sales' },
    ops_strategy:  { label: 'Ops & Strategy',  color: '#7E8EA6', short: 'Ops' },
    research_acad: { label: 'Research',         color: '#9B6B8A', short: 'Research' },
    other:         { label: 'Other',            color: '#A0A090', short: 'Other' },
  };

  function enableAI() { _aiEnabled = true; }
  function isAIEnabled() { return _aiEnabled; }

  function _cacheKey(p) {
    return `${p.f}|${p.l}|${p.p}|${p.c}`.toLowerCase();
  }

  /**
   * Regex-based fallback categorizer (instant, free).
   */
  function regexCategorize(p) {
    const t = ((p.p || '') + ' ' + (p.c || '')).toLowerCase();
    if (/\b(founder|co-founder|cofounder|founding team)\b/i.test(t)) return 'founder_ceo';
    if (/\b(ceo|chief executive)\b/i.test(t)) return 'founder_ceo';
    if (/\b(investor|vc |venture capital|angel|limited partner|portfolio|venture partner|gp |general partner)\b/i.test(t)) return 'investor_vc';
    if (/\b(cto|coo|cfo|cmo|cpo|cio|cro|chief|vp |vice president|head of|director|president|svp|evp)\b/i.test(t)) return 'exec_leader';
    if (/\b(engineer|developer|software|product manager|ml |machine learning|data scien|ai |artificial|full.?stack|backend|frontend|devops|sre|architect)\b/i.test(t)) return 'product_eng';
    if (/\b(sales|growth|marketing|gtm|go.to.market|business develop|partnerships|account exec|revenue|demand gen|sdr|bdr)\b/i.test(t)) return 'sales_growth';
    if (/\b(operations|strategy|consult|program manager|project manager|analyst|supply chain|logistics|transformation)\b/i.test(t)) return 'ops_strategy';
    if (/\b(research|professor|phd|academic|student|postdoc|lecturer|scientist|scholar)\b/i.test(t)) return 'research_acad';
    return 'other';
  }

  /**
   * Load cache from localStorage.
   */
  function loadCache() {
    try {
      const saved = localStorage.getItem('categorizer_cache');
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(_cache, parsed);
        return Object.keys(parsed).length;
      }
    } catch (e) { /* ignore */ }
    return 0;
  }

  function saveCache() {
    try {
      localStorage.setItem('categorizer_cache', JSON.stringify(_cache));
    } catch (e) { /* ignore */ }
  }

  /**
   * Categorize a single person (from cache or regex).
   */
  function categorize(p) {
    const key = _cacheKey(p);
    if (_cache[key]) return _cache[key];
    const cat = regexCategorize(p);
    _cache[key] = cat;
    return cat;
  }

  /**
   * AI batch categorization — sends up to 50 people per API call.
   * Returns number of people re-categorized.
   * @param {Array} people
   * @param {Function} onProgress - called with (completed, total)
   */
  async function aiCategorizeAll(people, onProgress) {
    if (!AIProvider.getProvider()) return 0;

    // Only send "other" people to AI — regex already handles clear cases.
    // This saves ~60% of tokens compared to sending everyone.
    const uncategorized = people.filter(p =>
      p._cat === 'other' && !_cache['ai:' + _cacheKey(p)]
    );
    if (!uncategorized.length) return 0;

    const BATCH_SIZE = 50;
    let changed = 0;
    const total = uncategorized.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = uncategorized.slice(i, i + BATCH_SIZE);
      const batchData = batch.map((p, idx) => ({
        id: idx,
        name: `${p.f} ${p.l}`,
        position: p.p || '',
        company: p.c || '',
      }));

      const systemPrompt = `You categorize professional contacts into exactly one of these categories:
- founder_ceo: Founders, co-founders, CEOs, people who started companies
- investor_vc: VCs, angels, investors, venture partners, LPs
- exec_leader: C-suite (CTO, COO, CFO etc), VPs, Directors, Heads of departments
- product_eng: Engineers, developers, PMs, data scientists, designers, technical roles
- sales_growth: Sales, marketing, growth, BD, partnerships, GTM roles
- ops_strategy: Operations, strategy, consulting, project/program management
- research_acad: Researchers, professors, PhD students, academics, scientists
- other: Anything that doesn't fit above

Respond ONLY with a JSON array of objects: [{"id": 0, "cat": "category_key"}, ...]
Be precise. Someone titled "Partner" at a VC firm is investor_vc. A "Partner" at a consulting firm is ops_strategy.`;

      const userMsg = JSON.stringify(batchData);

      try {
        const { text } = await AIProvider.aiCall(systemPrompt, userMsg, {
          temperature: 0.1,
          maxTokens: batch.length * 30,
          json: AIProvider.getProvider() !== 'claude',
        });

        // Parse response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const results = JSON.parse(jsonMatch[0]);
          results.forEach(r => {
            if (r.id >= 0 && r.id < batch.length && CATEGORIES[r.cat]) {
              const p = batch[r.id];
              const aiKey = 'ai:' + _cacheKey(p);
              _cache[aiKey] = r.cat;
              _cache[_cacheKey(p)] = r.cat; // overwrite regex
              p._cat = r.cat;
              changed++;
            }
          });
        }
      } catch (e) {
        console.warn('AI categorization batch failed:', e);
        // Continue with regex results for this batch
      }

      if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
    }

    saveCache();
    return changed;
  }

  /**
   * Get summary stats about current categorization.
   */
  function getStats(people) {
    const counts = {};
    for (const key of Object.keys(CATEGORIES)) counts[key] = 0;
    people.forEach(p => { counts[p._cat] = (counts[p._cat] || 0) + 1; });
    return counts;
  }

  return {
    CATEGORIES,
    enableAI,
    isAIEnabled,
    categorize,
    regexCategorize,
    aiCategorizeAll,
    loadCache,
    saveCache,
    getStats,
  };
})();
