/* Media Card Builder – frontend */
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let activeCardId = null;
let activeCard   = null;
let suggestions  = [];
let buildSSE     = null;
let searchTimer  = null;
let currentResults = [];   // raw album rows from last search
let sortBy  = 'artist';
let sortAsc = true;

// ── Utilities ──────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (!bytes) return '0 B';
  const gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  const mb = bytes / 1048576;
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => null);
}

function el(id) { return document.getElementById(id); }

function showErr(msg) { console.error(msg); alert('Error: ' + msg); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

// ── Art loading ────────────────────────────────────────────────────────────
// Use native loading="lazy" so the browser manages fetch priority.
// Fade in on load; handle the case where the image is already in cache
// (complete+naturalWidth check immediately after setting src).
function makeTileImg(albumId) {
  const img = document.createElement('img');
  img.className = 'tile-img';
  img.loading   = 'lazy';
  img.decoding  = 'async';
  img.alt       = '';
  img.addEventListener('load',  () => { img.style.opacity = '1'; });
  img.addEventListener('error', () => { img.style.opacity = '0'; });
  img.src = `/api/albums/${albumId}/art`;
  // If already cached, 'load' may have fired synchronously before the listener attached
  if (img.complete && img.naturalWidth > 0) img.style.opacity = '1';
  return img;
}

function makeThumbImg(albumId) {
  const img = document.createElement('img');
  img.className = 'album-thumb';
  img.loading   = 'lazy';
  img.decoding  = 'async';
  img.alt       = '';
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  img.src = `/api/albums/${albumId}/art`;
  return img;
}

// ── Resizable panes ────────────────────────────────────────────────────────
function initResizers() {
  // Horizontal: library height
  const libPane  = el('library-pane');
  const hResizer = el('h-resizer');

  const savedH = localStorage.getItem('libH');
  libPane.style.height = savedH ? savedH + 'px' : '50vh';

  hResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startY  = e.clientY;
    const startH  = libPane.getBoundingClientRect().height;
    const appH    = el('app').getBoundingClientRect().height;
    hResizer.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';

    const onMove = ev => {
      const h = Math.max(120, Math.min(appH - 120, startH + ev.clientY - startY));
      libPane.style.height = h + 'px';
    };
    const onUp = () => {
      hResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem('libH', libPane.getBoundingClientRect().height);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Vertical: cards pane width
  const cardsPane = el('cards-pane');
  const vResizer  = el('v-resizer');

  const savedW = localStorage.getItem('cardsW');
  cardsPane.style.width = savedW ? savedW + 'px' : '200px';

  vResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX  = e.clientX;
    const startW  = cardsPane.getBoundingClientRect().width;
    vResizer.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';

    const onMove = ev => {
      const w = Math.max(140, Math.min(420, startW + ev.clientX - startX));
      cardsPane.style.width = w + 'px';
    };
    const onUp = () => {
      vResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem('cardsW', cardsPane.getBoundingClientRect().width);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}
el('btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
applyTheme(localStorage.getItem('theme') || 'dark');

// ── Card list ──────────────────────────────────────────────────────────────
async function loadCards() {
  const cards = await api('GET', '/api/cards');
  const ul = el('card-list');
  ul.innerHTML = '';
  for (const c of cards) {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    li.innerHTML = `<div>${esc(c.name)}</div>
      <div class="card-meta">${c.target_size_gb} GB · ${c.album_count} albums</div>`;
    if (c.id === activeCardId) li.classList.add('active');
    li.addEventListener('click', () => selectCard(c.id));
    ul.appendChild(li);
  }
}

// ── Select / load card ─────────────────────────────────────────────────────
async function selectCard(id) {
  activeCardId = id;
  document.querySelectorAll('#card-list li').forEach(li =>
    li.classList.toggle('active', Number(li.dataset.id) === id)
  );
  el('no-card').classList.add('hidden');
  el('card-workspace').classList.remove('hidden');
  await refreshCard();
  renderTileGrid(); // update on-card indicators
}

async function refreshCard() {
  if (!activeCardId) return;
  try {
    activeCard = await api('GET', `/api/cards/${activeCardId}`);
  } catch (e) { showErr(e.message); return; }
  renderCardHeader();
  renderSpaceBar();
  renderCardAlbums();
}

// ── Card header ────────────────────────────────────────────────────────────
function renderCardHeader() {
  const c = activeCard;
  el('card-name-display').textContent = c.name;
  const accepted = c.albums.filter(a => a.accepted);
  el('card-stats-inline').textContent =
    `${accepted.length} album${accepted.length !== 1 ? 's' : ''} · ${fmt(c.used_bytes)} / ${c.target_size_gb} GB`;
}

// ── Space bar ──────────────────────────────────────────────────────────────
function renderSpaceBar() {
  const c = activeCard;
  const target = c.target_bytes;
  const used   = c.used_bytes;
  const suggestedBytes = suggestions.filter(s => s._pending).reduce((a, s) => a + s.size_bytes, 0);
  const usedPct = Math.min(used / target * 100, 100);
  const sugPct  = Math.min(suggestedBytes / target * 100, 100 - usedPct);
  el('space-used').style.width      = usedPct + '%';
  el('space-suggested').style.width = sugPct + '%';
  el('space-used-label').textContent = fmt(used) + ' used';
  el('space-remaining-label').textContent =
    fmt(Math.max(target - used - suggestedBytes, 0)) + ' remaining of ' + c.target_size_gb + ' GB';
}

// ── Card album list ────────────────────────────────────────────────────────
function renderCardAlbums() {
  const list = el('card-albums');
  list.innerHTML = '';
  const albums = activeCard.albums;
  if (!albums.length) {
    list.innerHTML = '<div class="album-item" style="color:var(--muted);font-size:12px;padding:12px">No albums added yet.</div>';
    return;
  }
  for (const a of albums) list.appendChild(buildCardAlbumRow(a));
}

function buildCardAlbumRow(a) {
  const div = document.createElement('div');
  div.className = 'album-item';
  if (!a.accepted) div.style.opacity = '0.45';

  const badge = a.added_by === 'suggestion'
    ? '<span class="badge-suggestion">suggest</span>' : '';

  div.appendChild(makeThumbImg(a.album_id));

  const info = document.createElement('div');
  info.className = 'album-info';
  info.innerHTML = `<div class="album-title">${esc(a.title)}${badge}</div>
    <div class="album-sub">${esc(a.artist)}${a.year ? ' · '+a.year : ''}${a.genres ? ' · '+esc(a.genres) : ''}</div>`;
  div.appendChild(info);

  const size = document.createElement('span');
  size.className = 'album-size';
  size.textContent = fmt(a.size_bytes);
  div.appendChild(size);

  const actions = document.createElement('div');
  actions.className = 'album-row-actions';
  actions.innerHTML = `
    <button class="icon-btn small btn-toggle" title="${a.accepted ? 'Exclude' : 'Include'}">${a.accepted ? '✓' : '○'}</button>
    <button class="icon-btn small btn-remove" title="Remove">✕</button>`;
  div.appendChild(actions);

  actions.querySelector('.btn-remove').addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/cards/${activeCardId}/albums/${a.album_id}`);
      await refreshCard(); renderTileGrid(); renderSuggestions();
    } catch (e) { showErr(e.message); }
  });
  actions.querySelector('.btn-toggle').addEventListener('click', async () => {
    try {
      await api('PATCH', `/api/cards/${activeCardId}/albums/${a.album_id}`, { accepted: !a.accepted });
      await refreshCard();
    } catch (e) { showErr(e.message); }
  });

  return div;
}

// ── Tile grid ──────────────────────────────────────────────────────────────
function sortedResults() {
  const onCardIds = new Set((activeCard?.albums || []).map(a => a.album_id));
  return [...currentResults].sort((a, b) => {
    let va, vb;
    switch (sortBy) {
      case 'title':  va = a.title;  vb = b.title;  break;
      case 'year':   va = a.year || 0; vb = b.year || 0; break;
      case 'size':   va = a.size_bytes; vb = b.size_bytes; break;
      default:       va = a.artist; vb = b.artist; break;
    }
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });
}

function renderTileGrid() {
  const grid = el('search-results');
  grid.innerHTML = '';

  const rows = sortedResults();
  const onCardIds = new Set((activeCard?.albums || []).map(a => a.album_id));

  el('search-count').textContent = rows.length ? `${rows.length} albums` : 'No results';

  for (const r of rows) {
    const isOnCard = r.on_card || onCardIds.has(r.id);
    const tile = document.createElement('div');
    tile.className = 'album-tile' + (isOnCard ? ' on-card' : '');
    tile.dataset.albumId = r.id;
    tile.title = `${r.artist} – ${r.title}${r.year ? ' ('+r.year+')' : ''}` +
                 `${r.genres ? '\n'+r.genres : ''}\n${fmt(r.size_bytes)}`;

    tile.appendChild(makeTileImg(r.id));

    const overlay = document.createElement('div');
    overlay.className = 'album-tile-overlay';
    overlay.innerHTML = `<div class="album-tile-title">${esc(r.title)}</div>
      <div class="album-tile-artist">${esc(r.artist)}</div>`;
    tile.appendChild(overlay);

    if (isOnCard) {
      const chk = document.createElement('div');
      chk.className = 'tile-check';
      chk.textContent = '✓';
      tile.appendChild(chk);
    } else {
      const handler = async () => {
        if (!activeCardId) { alert('Select a card first.'); return; }
        try {
          await api('POST', `/api/cards/${activeCardId}/albums`, { album_id: r.id });
          tile.classList.add('on-card');
          tile.removeEventListener('click', handler);
          const chk = document.createElement('div');
          chk.className = 'tile-check';
          chk.textContent = '✓';
          tile.appendChild(chk);
          await refreshCard();
        } catch (e) { showErr(e.message); }
      };
      tile.addEventListener('click', handler);
    }

    grid.appendChild(tile);
  }
}

// ── Sort controls ──────────────────────────────────────────────────────────
el('sort-by').addEventListener('change', () => {
  sortBy = el('sort-by').value;
  renderTileGrid();
});
el('btn-sort-dir').addEventListener('click', () => {
  sortAsc = !sortAsc;
  el('btn-sort-dir').textContent = sortAsc ? '↑' : '↓';
  renderTileGrid();
});

// ── Search / filters ───────────────────────────────────────────────────────
async function doSearch() {
  const q      = el('search-q').value.trim();
  const artist = el('search-artist').value.trim();
  const genre  = el('search-genre').value.trim();
  try {
    const params = new URLSearchParams({ limit: 400 });
    if (q)      params.set('q', q);
    if (artist) params.set('artist', artist);
    if (genre)  params.set('genre', genre);
    if (activeCardId) params.set('card_id', activeCardId);
    currentResults = await api('GET', `/api/albums/search?${params}`);
    renderTileGrid();
  } catch (e) { showErr(e.message); }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 350);
}

el('search-q').addEventListener('input', scheduleSearch);
el('search-artist').addEventListener('input', scheduleSearch);
el('search-genre').addEventListener('input', scheduleSearch);

// ── Fill suggestions ───────────────────────────────────────────────────────
el('btn-suggest').addEventListener('click', async () => {
  if (!activeCardId) return;
  const btn = el('btn-suggest');
  btn.disabled = true;
  btn.textContent = 'Calculating…';
  try {
    const res = await api('GET', `/api/cards/${activeCardId}/suggestions`);
    suggestions = res.suggestions.map(s => ({ ...s, _pending: true }));
    renderSuggestions();
    renderSpaceBar();
  } catch (e) { showErr(e.message); }
  finally {
    btn.disabled = false;
    btn.textContent = 'Fill suggestions';
  }
});

function renderSuggestions() {
  const sec  = el('suggestions-section');
  const list = el('suggestions-list');
  const pending = suggestions.filter(s => s._pending);
  if (!pending.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  list.innerHTML = '';

  for (const s of pending) {
    const div = document.createElement('div');
    div.className = 'album-item';

    div.appendChild(makeThumbImg(s.id));

    const info = document.createElement('div');
    info.className = 'album-info';
    info.innerHTML = `<div class="album-title">${esc(s.title)}</div>
      <div class="album-sub">${esc(s.artist)}${s.year ? ' · '+s.year : ''}${s.genres ? ' · '+esc(s.genres) : ''}</div>`;
    div.appendChild(info);

    const size = document.createElement('span');
    size.className = 'album-size';
    size.textContent = fmt(s.size_bytes);
    div.appendChild(size);

    const actions = document.createElement('div');
    actions.className = 'album-row-actions';
    actions.innerHTML = `<button class="icon-btn small btn-acc" title="Accept">✓</button>
      <button class="icon-btn small btn-rej" title="Reject">✕</button>`;
    div.appendChild(actions);

    actions.querySelector('.btn-acc').addEventListener('click', async () => {
      try {
        await api('POST', `/api/cards/${activeCardId}/suggestions/accept`, { album_ids: [s.id] });
        s._pending = false;
        await refreshCard(); renderSuggestions(); renderTileGrid();
      } catch (e) { showErr(e.message); }
    });
    actions.querySelector('.btn-rej').addEventListener('click', () => {
      s._pending = false;
      renderSuggestions(); renderSpaceBar();
    });

    list.appendChild(div);
  }
}

el('btn-accept-all').addEventListener('click', async () => {
  const pending = suggestions.filter(s => s._pending);
  if (!pending.length) return;
  try {
    await api('POST', `/api/cards/${activeCardId}/suggestions/accept`, {
      album_ids: pending.map(s => s.id),
    });
    suggestions.forEach(s => s._pending = false);
    await refreshCard(); renderSuggestions(); renderTileGrid();
  } catch (e) { showErr(e.message); }
});

el('btn-dismiss-suggestions').addEventListener('click', () => {
  suggestions = [];
  el('suggestions-section').classList.add('hidden');
  renderSpaceBar();
});

// ── Build ──────────────────────────────────────────────────────────────────
el('btn-build').addEventListener('click', async () => {
  if (!activeCardId) return;
  const output = activeCard?.output_path;
  if (!output) { alert('Set an output path in Settings before building.'); return; }
  try {
    await api('POST', `/api/cards/${activeCardId}/build`);
    startBuildSSE();
  } catch (e) { showErr(e.message); }
});

function startBuildSSE() {
  if (buildSSE) buildSSE.close();
  el('build-section').classList.remove('hidden');
  el('build-log').textContent = '';
  buildSSE = new EventSource(`/api/cards/${activeCardId}/build/stream`);
  buildSSE.onmessage = e => {
    const d = JSON.parse(e.data);
    el('build-bar').style.width  = (d.pct || 0) + '%';
    el('build-pct').textContent  = (d.pct || 0) + '%';
    el('build-eta').textContent  = d.eta_secs != null ? 'ETA ' + fmtDur(d.eta_secs) : '';
    el('build-current').textContent = d.current_album || '';
    if (d.new_log?.length) {
      el('build-log').textContent += d.new_log.join('\n') + '\n';
      el('build-log').scrollTop = el('build-log').scrollHeight;
    }
    if (d.status === 'done' || d.status === 'error') {
      buildSSE.close(); buildSSE = null; refreshCard();
    }
  };
  buildSSE.onerror = () => { if (buildSSE) { buildSSE.close(); buildSSE = null; } };
}

function fmtDur(s) {
  return s < 60 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's';
}

// ── Card settings modal ────────────────────────────────────────────────────
el('btn-card-settings').addEventListener('click', () => {
  if (!activeCard) return;
  el('cfg-name').value    = activeCard.name;
  el('cfg-size').value    = activeCard.target_size_gb;
  el('cfg-output').value  = activeCard.output_path || '';
  el('cfg-profile').value = activeCard.device_profile || 'generic';
  el('modal-card-settings').classList.remove('hidden');
});

el('btn-save-settings').addEventListener('click', async () => {
  try {
    await api('PATCH', `/api/cards/${activeCardId}`, {
      name:           el('cfg-name').value.trim(),
      target_size_gb: parseFloat(el('cfg-size').value),
      output_path:    el('cfg-output').value.trim(),
      device_profile: el('cfg-profile').value,
    });
    el('modal-card-settings').classList.add('hidden');
    await loadCards();
    await refreshCard();
  } catch (e) { showErr(e.message); }
});

el('btn-delete-card').addEventListener('click', async () => {
  if (!activeCard) return;
  if (!confirm(`Delete card "${activeCard.name}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/cards/${activeCardId}`);
    el('modal-card-settings').classList.add('hidden');
    activeCardId = null; activeCard = null;
    el('card-workspace').classList.add('hidden');
    el('no-card').classList.remove('hidden');
    await loadCards();
  } catch (e) { showErr(e.message); }
});

// ── New card modal ──────────────────────────────────────────────────────────
el('btn-new-card').addEventListener('click', () => el('modal-new-card').classList.remove('hidden'));

el('btn-create-card').addEventListener('click', async () => {
  const name  = el('new-card-name').value.trim();
  const size  = parseFloat(el('new-card-size').value);
  if (!name || !size) { alert('Name and size are required.'); return; }
  try {
    const { id } = await api('POST', '/api/cards', {
      name,
      target_size_gb: size,
      output_path:    el('new-card-output').value.trim(),
      device_profile: el('new-card-profile').value,
    });
    el('modal-new-card').classList.add('hidden');
    el('new-card-name').value = '';
    el('new-card-size').value = '32';
    el('new-card-output').value = '';
    await loadCards();
    selectCard(id);
  } catch (e) { showErr(e.message); }
});

// ── Modal close helpers ────────────────────────────────────────────────────
document.querySelectorAll('.modal-close').forEach(btn =>
  btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'))
);
document.querySelectorAll('.modal').forEach(m =>
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); })
);

// ── Init ───────────────────────────────────────────────────────────────────
initResizers();
loadCards();
doSearch();
