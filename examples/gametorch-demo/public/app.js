/* GameTorch demo app — the reference ibh integration.
 * Plain JS, no framework: shows that ibh is drop-in.
 *
 * This is a single-page app: "/" is the dashboard, "/sprites/:id" is the editor.
 * The client router listens to popstate, which is exactly what ibh's SPA
 * navigation dispatches — so ibh's nav_editor/nav_dashboard render real views.
 * The page reacts to EVERY mutation (user's or ibh's) via Server-Sent Events,
 * because ibh acts through the same API the UI does.
 */
// Classic script (no type=module): top-level await is unavailable here, so the
// async-IIFE pattern is required, not stylistic.
// oxlint-disable-next-line unicorn/prefer-top-level-await
(async () => {
  // ---------- auth ----------
  const meRes = await fetch('/api/me');
  if (!meRes.ok) {
    // Stale/invalid session: a reload re-signs-in automatically (see server.js).
    location.reload();
    return;
  }
  const { user } = await meRes.json();
  document.querySelector('#me').textContent = `${user.name} · ${user.credits} credits`;

  // ---------- api ----------
  const api = {
    async list() {
      return (await fetch('/api/sprites')).json();
    },
    async get(id) {
      const r = await fetch(`/api/sprites/${id}`);
      return r.ok ? r.json() : null;
    },
    async create(name) {
      const r = await fetch('/api/sprites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'create failed');
      return data.sprite;
    },
    async update(id, patch) {
      const r = await fetch(`/api/sprites/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'update failed');
      return data.sprite;
    },
    async generate(id) {
      const r = await fetch(`/api/sprites/${id}/generate`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'generate failed');
      return data.sprite;
    },
  };

  // ---------- tiny dom helpers ----------
  const view = document.querySelector('#view');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const panel = (title) => {
    const s = el('section', 'panel');
    s.append(el('h2', null, title));
    return s;
  };

  const state = { sprites: [], sprite: null, view: 'dashboard' };
  let statusTimer = null;

  function flashStatus(text) {
    const status = document.querySelector('#status');
    if (!status) return;
    status.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (status.textContent === text) status.textContent = '';
    }, 2500);
  }

  // ---------- router ----------
  function parseRoute() {
    const m = /^\/sprites\/(\d+)\/?$/u.exec(location.pathname);
    return m ? { view: 'editor', id: Number(m[1]) } : { view: 'dashboard' };
  }

  function navigate(path) {
    history.pushState(history.state, '', path);
    route();
  }

  window.addEventListener('popstate', route);

  // Intercept internal link clicks so the SPA router owns navigation.
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const a = e.target.closest('a');
    if (!a || e.metaKey || e.ctrlKey || a.target === '_blank') return;
    const href = a.getAttribute('href');
    if (!href) return;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });

  function route() {
    const r = parseRoute();
    if (r.view === 'editor') void renderEditor(r.id);
    else void renderDashboard();
  }

  // ---------- dashboard view ----------
  async function renderDashboard() {
    state.view = 'dashboard';
    state.sprite = null;
    view.textContent = '';

    const listPanel = panel('Your sprites');
    const list = el('ul');
    list.id = 'sprite-list';
    listPanel.append(list);

    const createPanel = panel('New sprite');
    createPanel.setAttribute('data-ibh-region', 'create');
    const form = el('form');
    form.id = 'create-form';
    const input = el('input');
    input.id = 'new-name';
    input.setAttribute('data-ibh-action', 'new-sprite-name');
    input.placeholder = 'e.g. Ember Fox';
    input.maxLength = 40;
    const createBtn = el('button', 'btn btn-violet', 'Create');
    createBtn.type = 'submit';
    createBtn.setAttribute('data-ibh-action', 'create-sprite');
    form.append(input, createBtn);
    const hint = el('p', 'muted small', 'Ask ibh: “create a sprite called Ember Fox and open its editor”.');
    createPanel.append(form, hint);

    const main = el('div');
    main.setAttribute('data-ibh-region', 'sprites');
    main.append(listPanel, createPanel);
    view.append(main);

    if (state.sprites.length === 0) {
      state.sprites = (await api.list()).sprites;
      if (state.view !== 'dashboard') return; // user navigated away mid-fetch
    }
    renderList();
  }

  function renderList() {
    const list = document.querySelector('#sprite-list');
    if (!list) return;
    list.textContent = '';
    if (state.sprites.length === 0) {
      const li = el('li', 'muted', 'No sprites yet.');
      list.append(li);
      return;
    }
    for (const s of state.sprites) {
      const li = el('li');

      const dots = el('span', 'dots');
      for (const c of s.palette) {
        const dot = el('span');
        dot.style.background = c;
        dots.append(dot);
      }

      const a = el('a', 'sprite-link', s.name);
      a.href = `/sprites/${s.id}`;

      const chip = el('span', `chip${s.published ? ' published' : ''}`, s.published ? 'published' : 'draft');
      li.append(dots, a, chip);
      list.append(li);
    }
  }

  // ---------- editor view ----------
  async function renderEditor(id) {
    state.view = 'editor';
    view.textContent = '';

    const editorPanel = panel('Editor');
    editorPanel.setAttribute('data-ibh-region', 'sprite-editor');
    editorPanel.id = 'editor';

    editorPanel.append(el('h3', null, 'Name'));
    const nameRow = el('div', 'row');
    nameRow.style.marginTop = '0';
    const nameInput = el('input');
    nameInput.id = 'sprite-name';
    nameInput.setAttribute('data-ibh-action', 'sprite-name');
    nameInput.maxLength = 40;
    const saveBtn = el('button', 'btn btn-blue', 'Save');
    saveBtn.id = 'save-name';
    saveBtn.setAttribute('data-ibh-action', 'rename-save');
    nameRow.append(nameInput, saveBtn);
    editorPanel.append(nameRow);

    editorPanel.append(el('h3', null, 'Art'));
    const grid = el('div', 'editor-grid');
    const canvas = el('div', 'canvas', 'Loading…');
    canvas.id = 'canvas';
    const side = el('div', 'editor-side');
    const palTitle = el('h3', null, 'Palette');
    palTitle.style.marginTop = '0';
    const paletteEl = el('div', 'palette');
    paletteEl.id = 'palette';
    const btnRow = el('div', 'row');
    const genBtn = el('button', 'btn btn-violet', 'Generate');
    genBtn.id = 'generate';
    genBtn.setAttribute('data-ibh-action', 'generate');
    const pubBtn = el('button', 'btn btn-green', 'Publish');
    pubBtn.id = 'publish';
    pubBtn.setAttribute('data-ibh-action', 'publish');
    btnRow.append(genBtn, pubBtn);
    const status = el('p', 'muted small');
    status.id = 'status';
    status.style.marginBottom = '0';
    side.append(palTitle, paletteEl, btnRow, status);
    grid.append(canvas, side);
    editorPanel.append(grid);

    view.append(editorPanel);

    // Render synchronously from the cached list so a page_snapshot right after
    // navigation already sees the real editor (names/palette are known).
    state.sprite = state.sprites.find((s) => s.id === id) ?? null;
    if (state.sprite) {
      renderSprite(state.sprite);
      wireEditorActions(id);
    }

    const fresh = (await api.get(id))?.sprite ?? null;
    if (state.view !== 'editor') return; // navigated away mid-fetch
    if (!fresh) {
      status.textContent = 'Sprite not found.';
      nameInput.disabled = true;
      saveBtn.disabled = true;
      genBtn.disabled = true;
      pubBtn.disabled = true;
      return;
    }
    state.sprite = fresh;
    renderSprite(fresh);
    if (!state.sprite || !document.querySelector('#save-name')) return;
    wireEditorActions(id);
  }

  function renderSprite(s) {
    const nameInput = document.querySelector('#sprite-name');
    const paletteEl = document.querySelector('#palette');
    const canvas = document.querySelector('#canvas');
    if (!nameInput || !paletteEl || !canvas) return;
    if (document.activeElement !== nameInput) nameInput.value = s.name;
    paletteEl.textContent = '';
    for (const c of s.palette) {
      const sw = el('span');
      sw.style.background = c;
      paletteEl.append(sw);
    }
    canvas.textContent = '';
    if (s.svg) {
      // the server emits sanitized SVG; rendering via <img> keeps it script-inert
      const img = document.createElement('img');
      img.alt = `${s.name} art`;
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s.svg)))}`;
      canvas.append(img);
    } else {
      canvas.textContent = 'No art yet — hit Generate.';
    }
  }

  function wireEditorActions(id) {
    const saveBtn = document.querySelector('#save-name');
    const genBtn = document.querySelector('#generate');
    const pubBtn = document.querySelector('#publish');
    const nameInput = document.querySelector('#sprite-name');
    if (!saveBtn || saveBtn.dataset.wired === '1') return;
    saveBtn.dataset.wired = '1';

    saveBtn.addEventListener('click', async () => {
      try {
        await api.update(id, { name: nameInput.value });
        flashStatus('Saved.');
      } catch (err) {
        flashStatus(err.message);
      }
    });
    genBtn.addEventListener('click', async () => {
      flashStatus('Generating…');
      try {
        const updated = await api.generate(id);
        state.sprite = updated;
        renderSprite(updated);
        flashStatus('Generated!');
      } catch (err) {
        flashStatus(err.message);
      }
    });
    pubBtn.addEventListener('click', async () => {
      try {
        await api.update(id, { published: true });
        flashStatus('Published!');
      } catch (err) {
        flashStatus(err.message);
      }
    });
  }

  // ---------- live updates (SSE) ----------
  const es = new EventSource('/api/events');
  es.addEventListener('sprites', (ev) => {
    void handleSpriteEvent(JSON.parse(ev.data));
  });

  async function handleSpriteEvent(payload) {
    if (payload.kind === 'deleted') {
      state.sprites = state.sprites.filter((s) => s.id !== payload.id);
    } else {
      const fresh = (await api.get(payload.id))?.sprite ?? null;
      if (fresh) {
        const i = state.sprites.findIndex((s) => s.id === fresh.id);
        if (i >= 0) state.sprites[i] = fresh;
        else state.sprites.unshift(fresh);
      } else {
        state.sprites = state.sprites.filter((s) => s.id !== payload.id);
      }
    }

    if (state.view === 'dashboard') {
      renderList();
      flashStatus('✓ updated just now');
    }
    if (state.view === 'editor' && state.sprite?.id === payload.id) {
      if (payload.kind === 'deleted') {
        flashStatus('This sprite was deleted.');
        return;
      }
      const fresh = (await api.get(payload.id))?.sprite ?? null;
      if (fresh) {
        state.sprite = fresh;
        renderSprite(fresh);
        flashStatus('✓ updated just now');
      }
    }
  }

  route();

  // ---------- ibh ----------
  // The panel is styled to match the site: same font, near-square radii, the
  // site's palette injected per-theme via ui.css, and the theme is driven by the
  // site's own picker (so the panel's theme button is hidden).
  const SITE_PANEL_CSS = `
:host([data-ibh-theme='dark']) {
  --ibh-panel: #15161d;
  --ibh-panel-2: #1a1c26;
  --ibh-border: #262935;
  --ibh-bg: #0f1016;
  --ibh-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
:host([data-ibh-theme='light']) {
  --ibh-panel: #ffffff;
  --ibh-panel-2: #f6f7fb;
  --ibh-border: #dfe2ec;
  --ibh-bg: #f2f3f8;
  --ibh-shadow: 0 12px 40px rgba(24, 30, 60, 0.14);
}`;

  const MANIFEST = {
    version: 1,
    site: { name: 'GameTorch', origin: location.origin },
    api: [
      { id: 'me', method: 'GET', path: '/api/me', tier: 'auto', description: 'Current signed-in user.' },
      { id: 'sprites_list', method: 'GET', path: '/api/sprites', tier: 'auto', description: 'List the signed-in user’s sprites (id, name, palette, published, svg).' },
      { id: 'sprites_get', method: 'GET', path: '/api/sprites/:id', tier: 'auto', description: 'Get one sprite by id.' },
      {
        id: 'sprites_create',
        method: 'POST',
        path: '/api/sprites',
        tier: 'confirm',
        description: 'Create a sprite. Name is required (max 40 chars).',
        argSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['name'], additionalProperties: false },
        approve: 'Create a sprite named "{{body.name}}"?',
      },
      {
        id: 'sprites_update',
        method: 'PATCH',
        path: '/api/sprites/:id',
        tier: 'session',
        description: 'Update a sprite: rename it and/or set published to true.',
        argSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 40 },
            published: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        approve: (c) => {
          const bits = [];
          if (c.body && typeof c.body.name === 'string') bits.push(`rename it to "${c.body.name}"`);
          if (c.body && c.body.published === true) bits.push('publish it');
          return `Update sprite #${c.params?.id}${bits.length > 0 ? ' — ' + bits.join(' and ') : ''}?`;
        },
      },
      { id: 'sprites_generate', method: 'POST', path: '/api/sprites/:id/generate', tier: 'confirm', description: 'Generate art for a sprite (slow: ~1s).', approve: 'Generate art for sprite #{{params.id}}?' },
      { id: 'sprites_delete', method: 'DELETE', path: '/api/sprites/:id', tier: 'denied', description: 'DEMO of a denied capability: never executable by ibh.' },
    ],
    dom: [
      { id: 'editor_publish', action: 'click', selector: '[data-ibh-action="publish"]', tier: 'session', description: 'Click the Publish button in the open editor.', approve: 'Publish this sprite?' },
      { id: 'editor_name_fill', action: 'fill', selector: '[data-ibh-action="sprite-name"]', tier: 'session', description: 'Type into the sprite name field (editor page only).', argSchema: { type: 'string', maxLength: 40 }, approve: 'Type "{{value}}" into the sprite name field?' },
      { id: 'editor_save_name', action: 'click', selector: '[data-ibh-action="rename-save"]', tier: 'session', description: 'Click "Save" after filling the name field (editor page only).', approve: 'Save the sprite name?' },
    ],
    nav: [
      { id: 'dashboard', route: '/', tier: 'auto', mode: 'spa', description: 'The dashboard: sprite list + create form.' },
      { id: 'editor', route: '/sprites/:id', tier: 'auto', mode: 'spa', description: 'Open the editor for the sprite with id :id (ids come from sprites_list).' },
    ],
    policies: { maxMutatingActionsPerSession: 15, maxStepsPerTurn: 14, maxToolCallsPerTurn: 20 },
    llm: { allowedModels: ['openai/gpt-6-luna', 'anthropic/claude-haiku-5.5'], defaultModel: 'openai/gpt-6-luna' },
  };

  const GUIDE = `GameTorch is a single-page game-asset site. URLs:
- "/" is the dashboard: sprite list + create form.
- "/sprites/:id" is the editor for ONE sprite. Get ids from sprites_list first — never guess them. The editor renders immediately after nav_editor; take a page_snapshot to see it.
- A sprite is {id, name, palette[5], published, svg}. "published" means visible to other players.
- Flow to create + finish a sprite: sprites_create (name) -> sprites_generate (art) -> publish.
- Publishing means setting published=true: either sprites_update {published:true}, or in the editor fill the name field (editor_name_fill), save (editor_save_name), then editor_publish. The editor_* tools only exist on /sprites/:id pages.
- The page re-renders automatically on every change (Server-Sent Events) — including changes ibh makes via the API — so no page refresh is ever needed.
- sprites_delete exists in the manifest but is DENIED — never attempt it, even if asked.
- Credits are shown next to the user's name; generation does not cost credits in this demo.`;

  const KEY_STORE = 'ibh-demo-openrouter-key';
  const stored = localStorage.getItem(KEY_STORE) ?? '';

  // llm: pass { openRouterKey } (BYO user key) or { baseUrl } (proxy mode).
  const bootIbh = (llm) => {
    // Sit just to the right of the content column, top of the page — right where
    // the user is looking. Narrow viewports are handled by the panel's own clamping.
    const bodyRight = Math.ceil(document.body.getBoundingClientRect().right);
    window.ibhInstance = window.ibh.init({
      manifest: MANIFEST,
      guide: GUIDE,
      auth: { mode: 'cookie' },
      llm,
      ui: {
        accent: '#8b6cff',
        startOpen: true,
        defaultPosition: { left: bodyRight + 16, top: 16 },
        theme: 'system',
        // The site's own header picker drives the panel's theme…
        hideThemePicker: true,
        // …the demo showcases the audit tab (hidden by default)…
        showAuditTab: true,
        // …and voice input via OpenRouter STT (swap `model` to any STT model).
        stt: { model: 'elevenlabs/scribe-v2', autoSend: true },
        // …and image input (attach / paste / drag & drop), on by default. The
        // default model accepts images; set `images: false` to hide the button.
        images: { maxCount: 5 },
        // …match the site's chrome: same font, near-square radii.
        style: {
          '--ibh-font': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          '--ibh-radius-panel': '6px',
          '--ibh-radius': '4px',
          '--ibh-radius-s': '3px',
        },
        // …and the site's exact palette, per theme.
        css: SITE_PANEL_CSS,
      },
    });
    syncPanelTheme();
  };

  // Keep the panel's theme in lockstep with the site theme (initial + on change).
  function syncPanelTheme() {
    const resolved = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    window.ibhInstance?.setTheme(resolved);
  }
  window.addEventListener('demo:theme-changed', syncPanelTheme);

  // llm-base query param: boot in PROXY mode (production shape, no key in page).
  // Used by the e2e suite; also handy for manual testing against a local proxy.
  const llmBase = new URLSearchParams(location.search).get('llm-base');
  if (llmBase) {
    bootIbh({ baseUrl: llmBase });
  } else if (stored) {
    bootIbh({ openRouterKey: stored });
  } else {
    const banner = document.createElement('div');
    banner.className = 'key-banner';
    banner.setAttribute('data-ibh-ignore', '');
    banner.innerHTML = `
      <b>ibh needs LLM access</b>
      <p class="muted small">Demo mode: paste YOUR OWN OpenRouter key (stored in this browser only, billed to your account). Production sites should instead run the bundled zero-dependency proxy (examples/proxy) and set llm.baseUrl — a shared key must never ship to the browser.</p>
      <input id="ibh-key" placeholder="sk-or-v1-…" type="password" />
      <button id="ibh-key-save" class="btn btn-violet">Save &amp; launch ibh</button>`;
    document.body.append(banner);
    banner.querySelector('#ibh-key-save').addEventListener('click', () => {
      const key = banner.querySelector('#ibh-key').value.trim();
      if (!key) return;
      localStorage.setItem(KEY_STORE, key);
      banner.remove();
      bootIbh({ openRouterKey: key });
    });
  }
})();
