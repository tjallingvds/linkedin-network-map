/**
 * API Key Modal — shown on first load or when no key is saved.
 * Supports OpenAI, Claude, and DeepSeek.
 */

const Modal = (() => {
  let _selectedProvider = 'deepseek';
  let _onComplete = null;

  function show(onComplete) {
    _onComplete = onComplete;
    const saved = _loadSaved();
    if (saved) {
      AIProvider.configure(saved.provider, saved.key);
      Categorizer.enableAI();
      const tavilyKey = _loadTavilyKey();
      if (tavilyKey) Enricher.configure(tavilyKey);
      if (_onComplete) _onComplete(true);
      return;
    }
    _render();
  }

  function _loadSaved() {
    try {
      const data = localStorage.getItem('ai_config');
      if (data) { const p = JSON.parse(data); if (p.provider && p.key) return p; }
    } catch { }
    return null;
  }

  function _loadTavilyKey() {
    try { return localStorage.getItem('tavily_key') || null; } catch { return null; }
  }

  function _saveTavilyKey(key) {
    if (key) localStorage.setItem('tavily_key', key);
    else localStorage.removeItem('tavily_key');
  }

  function _save(provider, key) {
    localStorage.setItem('ai_config', JSON.stringify({ provider, key }));
  }

  function _render() {
    const saved = _loadSaved();
    const tavilyKey = _loadTavilyKey();
    const aiOn = !!saved || !!AIProvider.getProvider();
    const searchOn = !!tavilyKey || Enricher.isConfigured();
    const currentProvider = AIProvider.getProvider() || (saved && saved.provider);
    const names = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'apiModal';

    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-x" id="modalClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>

        <div class="modal-head">
          <div class="modal-title">Settings</div>
          <div class="modal-sub">API keys are stored locally in your browser.</div>
        </div>

        <div class="modal-dots">
          <div class="modal-dot ${aiOn ? 'on' : ''}" id="dotAI"><span></span>${aiOn ? names[currentProvider] || 'AI' : 'AI'}</div>
          <div class="modal-dot ${searchOn ? 'on' : ''}" id="dotSearch"><span></span>Search</div>
        </div>

        <div class="modal-error" id="modalError"></div>

        <div class="modal-section">
          <div class="modal-section-label">Provider</div>
          <div class="modal-providers">
            ${['deepseek', 'openai', 'claude'].map(p => `
              <button class="mprov ${_selectedProvider === p ? 'sel' : ''}" data-provider="${p}">
                <span class="mprov-name">${names[p]}</span>
                <span class="mprov-cost">${{ deepseek: '$0.14', openai: '$0.15', claude: '$3.00' }[p]}/M</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="modal-section">
          <div class="modal-section-label">API Key</div>
          <div class="modal-field">
            <input type="password" class="modal-input" id="apiKeyInput"
              placeholder="${_getPlaceholder('deepseek')}" autocomplete="off" spellcheck="false">
          </div>
          <div class="modal-field-hint" id="keyHint">${_getHint('deepseek')}</div>
        </div>

        <div class="modal-sep"></div>

        <div class="modal-section">
          <div class="modal-section-label">Web Search <span class="modal-opt">optional</span></div>
          <div class="modal-field">
            <input type="password" class="modal-input" id="tavilyKeyInput"
              placeholder="tvly-..." autocomplete="off" spellcheck="false" value="${_loadTavilyKey() || ''}">
          </div>
          <div class="modal-field-hint">From <a href="https://app.tavily.com/home" target="_blank">app.tavily.com</a> — enables background research on people.</div>
        </div>

        <div class="modal-footer">
          <button class="modal-skip" id="skipBtn">Skip</button>
          <button class="modal-go" id="connectBtn" disabled>Connect</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    _bindEvents(overlay);
  }

  function _getPlaceholder(p) {
    return { openai: 'sk-...', claude: 'sk-ant-...', deepseek: 'sk-...' }[p] || 'sk-...';
  }

  function _getHint(p) {
    return {
      openai: 'From <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a> · gpt-4o-mini',
      claude: 'From <a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a> · claude-sonnet-4-20250514',
      deepseek: 'From <a href="https://platform.deepseek.com/" target="_blank">platform.deepseek.com</a> · deepseek-chat',
    }[p] || '';
  }

  function _bindEvents(overlay) {
    overlay.querySelectorAll('.mprov').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedProvider = btn.dataset.provider;
        overlay.querySelectorAll('.mprov').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        document.getElementById('apiKeyInput').placeholder = _getPlaceholder(_selectedProvider);
        document.getElementById('keyHint').innerHTML = _getHint(_selectedProvider);
      });
    });

    const input = document.getElementById('apiKeyInput');
    const connectBtn = document.getElementById('connectBtn');
    input.addEventListener('input', () => { connectBtn.disabled = input.value.trim().length < 8; });
    connectBtn.addEventListener('click', () => _handleConnect(overlay));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !connectBtn.disabled) _handleConnect(overlay); });

    document.getElementById('skipBtn').addEventListener('click', () => {
      overlay.remove();
      if (_onComplete) _onComplete(false);
    });

    document.getElementById('modalClose').addEventListener('click', () => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.15s';
      setTimeout(() => { overlay.remove(); if (_onComplete) _onComplete(false); }, 150);
    });

    setTimeout(() => input.focus(), 100);
  }

  async function _handleConnect(overlay) {
    const input = document.getElementById('apiKeyInput');
    const connectBtn = document.getElementById('connectBtn');
    const error = document.getElementById('modalError');
    const key = input.value.trim();

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    error.classList.remove('visible');

    AIProvider.configure(_selectedProvider, key);
    const valid = await AIProvider.validateKey();

    if (valid) {
      _save(_selectedProvider, key);
      Categorizer.enableAI();

      const tavilyInput = document.getElementById('tavilyKeyInput');
      const tavilyKey = tavilyInput ? tavilyInput.value.trim() : '';
      if (tavilyKey) { _saveTavilyKey(tavilyKey); Enricher.configure(tavilyKey); }
      else { _saveTavilyKey(null); }

      // Update dots to green
      const pNames = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
      const dotAI = document.getElementById('dotAI');
      if (dotAI) { dotAI.classList.add('on'); dotAI.childNodes[1].textContent = pNames[_selectedProvider] || 'AI'; }
      const tavilyVal = document.getElementById('tavilyKeyInput')?.value.trim();
      if (tavilyVal) { const dotS = document.getElementById('dotSearch'); if (dotS) dotS.classList.add('on'); }

      // Brief pause to show green state, then close
      setTimeout(() => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.15s';
        setTimeout(() => { overlay.remove(); if (_onComplete) _onComplete(true); }, 150);
      }, 400);
    } else {
      error.textContent = 'Invalid key or connection failed.';
      error.classList.add('visible');
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  }

  function showSettings() {
    _render();
  }

  return { show, showSettings };
})();
