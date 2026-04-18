/**
 * PersonModal — full-screen enrichment modal for call/outreach prep.
 * Shows comprehensive person profile with sources, talking points, and quick actions.
 */

const PersonModal = (() => {
  let _overlay = null;
  let _searchContext = null; // current search query for relevance rationale

  function _esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Set the current search context so the modal can generate relevance rationale. */
  function setSearchContext(query) {
    _searchContext = query;
  }

  /**
   * Show the enrichment modal for a person.
   * If profile is null, shows loading state and fetches enrichment.
   */
  async function show(person, profile, opts = {}) {
    // Close any existing modal
    close();

    const cat = Categorizer.CATEGORIES[person._cat];
    const avatarColor = opts.avatarColor || cat?.color || '#999';
    const initials = (person.f[0] || '') + (person.l[0] || '');

    _overlay = document.createElement('div');
    _overlay.className = 'pm-overlay';
    _overlay.id = 'personModal';

    // Render immediately with loading or data
    _render(person, profile, cat, initials, avatarColor);
    document.body.appendChild(_overlay);

    // Bind close events
    _overlay.querySelector('.pm-close').addEventListener('click', close);
    _overlay.addEventListener('click', (e) => { if (e.target === _overlay) close(); });
    document.addEventListener('keydown', _onEscape);

    // If we have pre-computed relevance text, show it immediately
    if (opts.relevance) {
      _lastRelevanceHtml = `<div class="pm-section-title">Why Relevant</div><p class="pm-relevance-text">${_esc(opts.relevance)}</p>`;
      _injectRelevance(_lastRelevanceHtml);
    } else if (_searchContext) {
      // Generate relevance rationale via AI if we have search context
      _generateRelevance(person, profile, _searchContext);
    }

    // Clear body placeholder if no rich profile data
    const hasRichData = profile && (profile.bio || profile.previousRoles?.length || profile.talkingPoints?.length);
    if (!hasRichData && Enricher.isConfigured()) {
      _showEnrichButton(person, cat, initials);
    }
  }

  /**
   * Show relevance context in the modal body when no enrichment is loaded.
   */
  function _showEnrichButton(person, cat, initials) {
    if (!_overlay) return;
    const body = _overlay.querySelector('.pm-body');
    if (!body) return;
    // Body is empty until relevance loads — the .pm-relevance slot above will show it
    body.innerHTML = '';
  }

  let _lastRelevanceHtml = ''; // cached so we can re-inject after re-render

  /**
   * Generate a short relevance rationale for why this person matches the search.
   * Updates the modal in-place with the result. Can run in parallel with enrichment.
   */
  async function _generateRelevance(person, profile, searchQuery) {
    if (!AIProvider.getProvider()) return;
    _lastRelevanceHtml = '';

    // Show loading state immediately
    _injectRelevance('<div class="pm-relevance-loading">Checking relevance...</div>');

    try {
      // Build person info from what we have — profile may be null during enrichment
      const personInfo = `${person.f} ${person.l}, ${person.p || ''} at ${person.c || ''}.` +
        (profile?.bio ? ' ' + profile.bio : '') +
        (profile?.previousRoles?.length ? ' Previous: ' + profile.previousRoles.map(r => `${r.title} at ${r.company}`).join(', ') : '');

      const { text } = await AIProvider.aiCall(
        `You write a 1-2 sentence relevance note explaining why a person is a good match for a search query.
Be specific — reference their role, company, or experience. Keep it short and direct.
Output ONLY the relevance note, nothing else.`,
        `Search: "${searchQuery}"\nPerson: ${personInfo}`,
        { temperature: 0.3, maxTokens: 100 }
      );

      if (text) {
        _lastRelevanceHtml = `<div class="pm-section-title">Why Relevant</div><p class="pm-relevance-text">${_esc(text.trim())}</p>`;
        _injectRelevance(_lastRelevanceHtml);
      }
    } catch (e) {
      console.warn('Relevance generation failed:', e);
      _injectRelevance(''); // clear loading state
    }
  }

  /** Inject HTML into the relevance slot (if modal is still open). */
  function _injectRelevance(html) {
    if (!_overlay) return;
    const slot = _overlay.querySelector('.pm-relevance');
    if (slot) slot.innerHTML = html;
  }

  function _onEscape(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    document.removeEventListener('keydown', _onEscape);
    if (_overlay) {
      _overlay.style.opacity = '0';
      _overlay.style.transition = 'opacity 0.15s';
      const el = _overlay;
      _overlay = null;
      setTimeout(() => el.remove(), 150);
    }
  }

  function _render(person, profile, cat, initials, avatarColor) {
    if (!_overlay) return;

    const linkedinUrl = profile?.linkedinUrl || person.u || '';
    const isLoading = !profile;
    const bgColor = avatarColor || cat?.color || '#999';

    _overlay.innerHTML = `
      <div class="pm-card">
        <button class="pm-close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>

        <div class="pm-header">
          <div class="pm-avatar" style="background:${bgColor}">${initials}</div>
          <div class="pm-header-info">
            <div class="pm-name">${_esc(person.f)} ${_esc(person.l)}</div>
            <div class="pm-role">${_esc(person.p || '')}</div>
            <div class="pm-company">${_esc(person.c || '')}</div>
            ${profile?.linkedinHeadline ? `<div class="pm-headline">${_esc(profile.linkedinHeadline)}</div>` : ''}
          </div>
        </div>

        <div class="pm-actions">
          ${linkedinUrl ? `<a href="${_esc(linkedinUrl)}" target="_blank" class="pm-action-btn pm-action-linkedin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>
            LinkedIn
          </a>` : ''}
          ${person.e ? `<button class="pm-action-btn pm-action-email" onclick="navigator.clipboard.writeText('${_esc(person.e)}');this.textContent='Copied!'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            ${_esc(person.e)}
          </button>` : ''}
          ${profile?.location ? `<span class="pm-location">${_esc(profile.location)}</span>` : ''}
        </div>

        <div class="pm-relevance"></div>

        <div class="pm-body">
          ${isLoading ? _renderLoading() : _renderProfile(profile)}
        </div>
      </div>
    `;

    // Re-bind close since innerHTML replaced the button
    _overlay.querySelector('.pm-close').addEventListener('click', close);
  }

  function _renderLoading() {
    return `
      <div class="pm-loading">
        <div class="pm-loading-dots"><span></span><span></span><span></span></div>
        <div class="pm-loading-text">Searching the web for background info...</div>
      </div>
    `;
  }

  function _renderProfile(profile) {
    if (!profile) return '<div class="pm-empty">No background information found.</div>';
    const parts = [];

    // Bio
    if (profile.bio) {
      parts.push(`<div class="pm-section pm-bio-section"><p class="pm-bio">${_esc(profile.bio)}</p></div>`);
    }

    // Talking Points (for call prep)
    if (profile.talkingPoints?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Talking Points</div>
          <div class="pm-talking-points">
            ${profile.talkingPoints.map(t => `<div class="pm-talking-point">${_esc(t)}</div>`).join('')}
          </div>
        </div>
      `);
    }

    // Previous Roles
    if (profile.previousRoles?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Career History</div>
          <div class="pm-timeline">
            ${profile.previousRoles.map(r => `
              <div class="pm-timeline-item">
                <div class="pm-timeline-dot"></div>
                <div class="pm-timeline-content">
                  <div class="pm-timeline-title">${_esc(r.title)}</div>
                  <div class="pm-timeline-sub">${_esc(r.company)}${r.period ? ` <span class="pm-period">${_esc(r.period)}</span>` : ''}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `);
    }

    // Education
    if (profile.education?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Education</div>
          ${profile.education.map(e => `
            <div class="pm-edu-item">
              <div class="pm-edu-school">${_esc(e.school)}</div>
              <div class="pm-edu-detail">${_esc(e.degree || '')}${e.field ? ' in ' + _esc(e.field) : ''}${e.year ? ` <span class="pm-period">${_esc(e.year)}</span>` : ''}</div>
            </div>
          `).join('')}
        </div>
      `);
    }

    // Skills
    if (profile.skills?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Skills</div>
          <div class="pm-skills">${profile.skills.map(s => `<span class="pm-skill">${_esc(s)}</span>`).join('')}</div>
        </div>
      `);
    }

    // Notable Achievements
    if (profile.notableAchievements?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Notable</div>
          <ul class="pm-achievements">${profile.notableAchievements.map(a => `<li>${_esc(a)}</li>`).join('')}</ul>
        </div>
      `);
    }

    // Interests
    if (profile.interests?.length > 0) {
      parts.push(`
        <div class="pm-section">
          <div class="pm-section-title">Interests</div>
          <div class="pm-skills">${profile.interests.map(i => `<span class="pm-skill pm-interest">${_esc(i)}</span>`).join('')}</div>
        </div>
      `);
    }

    // Sources
    if (profile.sources?.length > 0) {
      parts.push(`
        <div class="pm-section pm-sources-section">
          <div class="pm-section-title">Sources</div>
          <div class="pm-sources">
            ${profile.sources.map(s => `
              <a href="${_esc(s.url)}" target="_blank" class="pm-source">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span>${_esc(s.title || new URL(s.url).hostname)}</span>
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    if (parts.length === 0) {
      return '<div class="pm-empty">No detailed background information found.</div>';
    }

    return parts.join('');
  }

  /**
   * Show modal for a discovered person (from web search).
   * Accepts { name, title, company, context, linkedin, source }.
   * Converts to the network person format and shows the modal.
   */
  function showDiscovered(discovered) {
    const nameParts = (discovered.name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Build a pseudo-person object compatible with the modal
    const person = {
      f: firstName,
      l: lastName,
      p: discovered.title || '',
      c: discovered.company || '',
      e: '',
      u: discovered.linkedin || '',
      _cat: 'other',
    };

    // Build a minimal profile from what we have
    const profile = {
      bio: discovered.context || '',
      previousRoles: [],
      education: [],
      skills: [],
      notableAchievements: [],
      location: '',
      linkedinHeadline: '',
      linkedinUrl: discovered.linkedin || '',
      interests: [],
      talkingPoints: [],
      sources: discovered.source ? [{ title: 'Source', url: discovered.source }] : [],
    };

    // Show what we have — user can click "Enrich" button in modal for more
    show(person, profile);
  }

  return { show, showDiscovered, close, setSearchContext };
})();
