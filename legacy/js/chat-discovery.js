/**
 * ChatDiscovery — web discovery orchestration.
 *
 * Handles brief parsing, multi-round search, result filtering
 * (dedup, invitation exclusion, cleanup, brief-based hard filter).
 */

const ChatDiscovery = (() => {

  /**
   * Parse a research brief into structured search parameters.
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
      const result = AIJSON.extractObject(text, 'parseBrief');
      if (result.ok) return result.data;
    } catch (e) {
      console.warn('Brief parsing failed:', e);
    }
    return null;
  }

  // ─── Filter sub-functions ──────────────────────────────────

  function _deduplicateByName(people) {
    const seen = new Set();
    return people.filter(p => {
      if (!p.name) return false;
      const key = p.name.toLowerCase().trim().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function _excludeInvitations(people) {
    try {
      const invData = localStorage.getItem('invitations_data');
      if (!invData) return people;

      const invitations = JSON.parse(invData);
      const invNames = new Set(invitations.map(inv => inv.name.toLowerCase().trim()));
      const invUrls = new Set(invitations.map(inv => (inv.url || '').toLowerCase().replace(/\/$/, '')));

      const filtered = people.filter(p => {
        const nameLower = (p.name || '').toLowerCase().trim();
        const linkedinLower = (p.linkedin || '').toLowerCase().replace(/\/$/, '');
        if (invNames.has(nameLower)) return false;
        if (linkedinLower && invUrls.has(linkedinLower)) return false;
        return true;
      });

      const excluded = people.length - filtered.length;
      if (excluded > 0) console.log(`Excluded ${excluded} pending invitations`);
      return filtered;
    } catch { return people; }
  }

  function _cleanBadEntries(people) {
    return people.filter(p => {
      const name = (p.name || '').trim();
      if (!name.includes(' ')) return false;
      if (name.length < 4) return false;
      if (/^(not specified|unknown|n\/a|company representative|author)/i.test(name)) return false;
      if (/^(not specified|unknown|n\/a)/i.test(p.title || '')) return false;
      return true;
    });
  }

  function _applyBriefFilters(people) {
    const parsedBrief = ChatState.getParsedBrief();
    if (!parsedBrief) return people;

    const exFirms = (parsedBrief.excludeFirms || []).map(f => f.toLowerCase());
    const exTitles = (parsedBrief.excludeTitles || []).map(t => t.toLowerCase());
    const exSeniority = (parsedBrief.excludeSeniority || []).map(s => s.toLowerCase());
    const targetFirms = (parsedBrief.firms || []).map(f => f.toLowerCase());

    const exFirmWords = exFirms.map(f => f.split(/[\s,&]+/).filter(w => w.length > 2));
    const targetFirmWords = targetFirms.map(f => f.split(/[\s,&]+/).filter(w => w.length > 2));

    const companyMatchesExcluded = (company) => {
      if (!company) return false;
      const c = company.toLowerCase();
      if (exFirms.some(ef => c.includes(ef) || ef.includes(c))) return true;
      return exFirmWords.some(words => {
        const matches = words.filter(w => c.includes(w));
        return matches.length >= 2 || (words.length === 1 && matches.length === 1);
      });
    };

    const companyMatchesTarget = (company) => {
      if (!company) return false;
      const c = company.toLowerCase();
      if (targetFirms.some(tf => c.includes(tf) || tf.includes(c))) return true;
      return targetFirmWords.some(words => {
        const matches = words.filter(w => c.includes(w));
        return matches.length >= 2 || (words.length === 1 && matches.length === 1);
      });
    };

    const filtered = people.filter(p => {
      const title = (p.title || '').toLowerCase();
      if (companyMatchesExcluded(p.company)) return false;
      if (exSeniority.some(es => title.includes(es))) return false;
      if (exTitles.some(et => title.includes(et))) return false;
      if (targetFirms.length > 0 && !companyMatchesTarget(p.company)) return false;
      return true;
    });

    console.log(`After hard filter: ${filtered.length} (removed ${people.length - filtered.length})`);
    return filtered;
  }

  /**
   * Full filter pipeline for discovery results.
   */
  async function _filterDiscoveryResults(people, query) {
    console.log(`Filter input: ${people.length} people`);
    if (!people.length || people.length <= 3) return people;

    let result = _deduplicateByName(people);
    console.log(`After dedup: ${result.length}`);

    result = _excludeInvitations(result);

    result = _cleanBadEntries(result);
    console.log(`After cleanup: ${result.length}`);

    result = _applyBriefFilters(result);

    return result;
  }

  /**
   * Handle a single round of outbound discovery.
   */
  async function handleDiscovery(query, userMessage, targetCount = 15, extractionHint = '') {
    PersonModal.setSearchContext(query);
    try {
      const allData = ChatState.getAllData();
      const isInNetwork = (name) => {
        if (!name) return null;
        const nameLower = name.toLowerCase().trim();
        const nameParts = nameLower.split(/\s+/).filter(w => w.length > 1);
        if (nameParts.length < 2) return null;

        return allData.find(p => {
          const first = (p.f || '').toLowerCase();
          const last = (p.l || '').toLowerCase();
          const fullName = `${first} ${last}`;
          if (fullName === nameLower) return true;
          if (nameParts.includes(first) && nameParts.includes(last)) return true;
          return false;
        });
      };

      const progressCb = ChatEnrich.getDiscoveryProgressCallback();
      const result = await Enricher.discoverPeople(query, (status, done, total) => {
        if (progressCb) progressCb(status, done, total, query);
      }, targetCount, extractionHint);

      if (!result.people.length) {
        return { text: 'No results found.', tokensUsed: 0, people: [] };
      }

      const filteredPeople = await _filterDiscoveryResults(result.people, query);
      let people = filteredPeople
        .map(p => ({ ...p, inNetwork: isInNetwork(p.name) }))
        .filter(p => p.confidence !== 'low');

      const confOrder = { high: 0, medium: 1 };
      people.sort((a, b) => (confOrder[a.confidence] ?? 1) - (confOrder[b.confidence] ?? 1));

      return { text: '', tokensUsed: 0, discovered: true, people, query };
    } catch (e) {
      const errMsg = `Discovery failed: ${e.message}`;
      ChatState.pushMessage('assistant', errMsg);
      return { text: errMsg, tokensUsed: 0 };
    }
  }

  /**
   * Multi-round discovery from a research brief.
   * Parses brief, builds extraction context, loops until target met.
   */
  async function discover(query, targetCount) {
    ChatState.setCurrentBrief(query);
    PersonModal.setSearchContext(query);

    const parsed = await _parseBrief(query);
    let extractCtx = '';

    if (parsed && parsed.firms?.length > 0) {
      console.log('Parsed brief:', parsed);
      ChatState.setParsedBrief(parsed);

      if (parsed.context) extractCtx += `LOOKING FOR: ${parsed.context}\n`;
      extractCtx += `TARGET FIRMS (only extract people at these): ${parsed.firms.join(', ')}\n`;
      if (parsed.titles?.length) extractCtx += `TARGET TITLES: ${parsed.titles.join(', ')}\n`;
      if (parsed.excludeFirms?.length) extractCtx += `EXCLUDE firms: ${parsed.excludeFirms.join(', ')}\n`;
      if (parsed.excludeSeniority?.length) extractCtx += `EXCLUDE seniority: ${parsed.excludeSeniority.join(', ')}\n`;
    } else {
      ChatState.setParsedBrief(null);
    }

    const allPeople = [];
    const seenNames = new Set();
    const maxRounds = 3;

    // Pre-seed with invitation names
    try {
      const invData = localStorage.getItem('invitations_data');
      if (invData) {
        JSON.parse(invData).forEach(inv => {
          if (inv.name) seenNames.add(inv.name.toLowerCase().trim());
        });
        console.log(`Pre-excluded ${seenNames.size} invitation names`);
      }
    } catch { /* ignore */ }

    for (let round = 0; round < maxRounds; round++) {
      const remaining = targetCount - allPeople.length;
      if (remaining <= 0) break;

      const roundQuery = round === 0
        ? query
        : query + `\n\n(ROUND ${round + 1}: Find DIFFERENT people. Already found: ${allPeople.map(p => p.name).join(', ')}. Do NOT return these again.)`;

      const result = await handleDiscovery(roundQuery, query, remaining, extractCtx);

      if (!result.people?.length) break;

      let newCount = 0;
      for (const p of result.people) {
        const key = (p.name || '').toLowerCase().trim();
        if (key && !seenNames.has(key)) {
          seenNames.add(key);
          allPeople.push(p);
          newCount++;
        }
      }

      console.log(`Discovery round ${round + 1}: found ${newCount} new people (total: ${allPeople.length}/${targetCount})`);

      if (newCount < 3) break;
    }

    const highConf = allPeople.filter(p => p.confidence === 'high').length;
    const text = `${allPeople.length} qualified leads found${highConf > 0 ? `, ${highConf} high confidence` : ''}.`;
    ChatState.pushMessage('assistant', text);

    ChatState.setLastDiscovery({ people: allPeople, query, peopleContext: '' });

    return {
      text,
      tokensUsed: 0,
      discovered: true,
      people: allPeople,
      query,
    };
  }

  return { discover, handleDiscovery };
})();
