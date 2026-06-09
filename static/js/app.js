/* Media Card Builder – frontend */
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let activeCardId = null;
let activeCard   = null;
let suggestions  = [];
let buildSSE     = null;
let syncSSE      = null;
let searchTimer  = null;
let currentResults = [];
let sortBy  = 'added';
let sortAsc = false;
let cardSortBy  = 'artist';
let cardSortAsc = true;

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
function makeTileImg(albumId) {
  const img = document.createElement('img');
  img.className = 'tile-img';
  img.loading   = 'lazy';
  img.decoding  = 'async';
  img.alt       = '';
  img.addEventListener('load',  () => { img.style.opacity = '1'; });
  img.addEventListener('error', () => { img.style.opacity = '0'; });
  img.src = `/api/albums/${albumId}/art`;
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
  const libPane  = el('library-pane');
  const hResizer = el('h-resizer');
  const savedH   = localStorage.getItem('libH');
  libPane.style.height = savedH ? savedH + 'px' : '50vh';

  hResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = libPane.getBoundingClientRect().height;
    const appH   = el('app').getBoundingClientRect().height;
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

  const cardsPane = el('cards-pane');
  const vResizer  = el('v-resizer');
  const savedW    = localStorage.getItem('cardsW');
  cardsPane.style.width = savedW ? savedW + 'px' : '200px';

  vResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = cardsPane.getBoundingClientRect().width;
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

// ── Tile size slider ───────────────────────────────────────────────────────
function initTileSlider() {
  const slider = el('tile-size-slider');
  const saved  = localStorage.getItem('tileSize');
  if (saved) slider.value = saved;
  const apply = () => {
    document.documentElement.style.setProperty('--tile-size', slider.value + 'px');
    localStorage.setItem('tileSize', slider.value);
  };
  apply();
  slider.addEventListener('input', apply);
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
    const pill = stagePill(c.stage_status);
    li.innerHTML = `<div>${esc(c.name)}${pill}</div>
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
  el('library-hint').classList.remove('hidden');
  await refreshCard();
  await doSearch();
}

async function refreshCard() {
  if (!activeCardId) return;
  try {
    activeCard = await api('GET', `/api/cards/${activeCardId}`);
  } catch (e) { showErr(e.message); return; }
  renderCardHeader();
  renderSpaceBar();
  renderCardAlbums();
  renderPersonal();
  renderUnmanaged();
  await reattachJobs();
}

async function reattachJobs() {
  if (!activeCardId) return;
  try {
    if (!buildSSE) {
      const b = await api('GET', `/api/cards/${activeCardId}/build/status`);
      if (b.status === 'running') startBuildSSE();
    }
    if (!syncSSE) {
      const s = await api('GET', `/api/cards/${activeCardId}/sync/status`);
      if (s.status === 'running') startSyncSSE();
    }
  } catch (_) {}
}

// ── Stage status pill ──────────────────────────────────────────────────────
function stagePill(status) {
  const labels = { none: 'not built', stale: 'rebuild needed', fresh: 'ready to sync' };
  return `<span class="stage-pill stage-${status||'none'}">${labels[status]||'not built'}</span>`;
}

// ── Card header ────────────────────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function renderCardHeader() {
  const c = activeCard;
  el('card-name-display').innerHTML = esc(c.name) + stagePill(c.stage_status);
  const accepted = c.albums.filter(a => a.accepted);

  const parts = [
    `${accepted.length} album${accepted.length !== 1 ? 's' : ''}`,
    `${fmt(c.used_bytes)} / ${c.target_size_gb} GB`,
  ];
  if (c.staging_total > 0) {
    const missing = c.staging_total - (c.staging_present || 0);
    if (missing > 0)
      parts.push(`${missing} of ${c.staging_total} not in staging`);
    else
      parts.push(`staging complete`);
  }
  const built = relativeTime(c.last_built_at);
  if (built) parts.push(`built ${built}`);

  el('card-stats-inline').textContent = parts.join(' · ');

  const status = c.stage_status || 'none';
  el('btn-build').textContent = status === 'none' ? 'Build' : 'Rebuild';
  el('btn-sync').disabled     = status === 'none';
  el('btn-sync').title        = status === 'none' ? 'Build first to create staging'
                              : status === 'stale' ? 'Staging is out of date — consider rebuilding first'
                              : '';

  const hasSuggestions = c.albums.some(a => a.added_by === 'suggestion' && a.accepted);
  el('btn-remove-suggestions').classList.toggle('hidden', !hasSuggestions);
}

// ── Space bar ──────────────────────────────────────────────────────────────
function renderSpaceBar() {
  const c      = activeCard;
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
function sortedCardAlbums() {
  return [...activeCard.albums].sort((a, b) => {
    let va, vb;
    switch (cardSortBy) {
      case 'title': va = a.title;     vb = b.title;     break;
      case 'added': va = a.added_at ? new Date(a.added_at).getTime() : 0;
                    vb = b.added_at ? new Date(b.added_at).getTime() : 0; break;
      default:      va = a.sort_name || a.artist; vb = b.sort_name || b.artist; break;
    }
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return cardSortAsc ? cmp : -cmp;
  });
}

function renderCardAlbums() {
  const list = el('card-albums');
  list.innerHTML = '';
  if (!activeCard.albums.length) {
    list.innerHTML = '<div class="album-item" style="color:var(--muted);font-size:12px;padding:12px">No albums added yet.</div>';
    return;
  }
  for (const a of sortedCardAlbums()) list.appendChild(buildCardAlbumRow(a));
}

function buildCardAlbumRow(a) {
  const div = document.createElement('div');
  div.className = 'album-item' + (a.added_by === 'suggestion' ? ' is-suggestion' : '');
  if (!a.accepted) div.style.opacity = '0.45';

  const badge = a.added_by === 'suggestion'
    ? '<span class="badge-suggestion">Suggested</span>' : '';

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
      await refreshCard(); await doSearch(); renderSuggestions();
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

// ── Unmanaged folders ──────────────────────────────────────────────────────
function renderUnmanaged() {
  const sec   = el('unmanaged-section');
  const list  = el('unmanaged-list');
  const paths = activeCard?.unmanaged_paths || [];

  if (!paths.length) { sec.classList.add('hidden'); return; }

  sec.classList.remove('hidden');
  el('unmanaged-count').textContent = paths.length;
  list.innerHTML = '';

  for (const u of paths) {
    const div = document.createElement('div');
    div.className = 'album-item';

    const info = document.createElement('div');
    info.className = 'album-info';
    info.innerHTML = `<div class="album-title">${esc(u.folder_name)}</div>
      <div class="album-sub">Not in library</div>`;
    div.appendChild(info);

    const size = document.createElement('span');
    size.className = 'album-size';
    size.textContent = fmt(u.size_bytes);
    div.appendChild(size);

    const actions = document.createElement('div');
    actions.className = 'album-row-actions';
    actions.innerHTML = `<button class="icon-btn small" title="Forget — will be removed from card on next sync">✕</button>`;
    div.appendChild(actions);

    actions.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Forget "${u.folder_name}"?\n\nIt will be deleted from the card on the next sync.`)) return;
      try {
        await api('DELETE', `/api/cards/${activeCardId}/unmanaged/${u.id}`);
        await refreshCard();
      } catch (e) { showErr(e.message); }
    });

    list.appendChild(div);
  }
}

// ── Personal content ───────────────────────────────────────────────────────
function renderPersonal() {
  const items = activeCard?.personal_items || [];
  el('personal-count').textContent = items.length || '';
  const list = el('personal-list');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<div class="album-item" style="color:var(--muted);font-size:12px;padding:10px 12px">No personal content added yet.</div>';
    return;
  }

  for (const p of items) {
    const div = document.createElement('div');
    div.className = 'album-item is-personal';

    const info = document.createElement('div');
    info.className = 'album-info';
    info.innerHTML = `<div class="album-title">${esc(p.display_name)}<span class="badge-personal">Personal</span></div>
      <div class="album-sub">${p.folder_name !== p.display_name ? esc(p.folder_name) : ''}</div>`;
    div.appendChild(info);

    const size = document.createElement('span');
    size.className = 'album-size';
    size.textContent = fmt(p.size_bytes);
    div.appendChild(size);

    const actions = document.createElement('div');
    actions.className = 'album-row-actions';
    actions.innerHTML = `<button class="icon-btn small btn-remove" title="Remove">✕</button>`;
    div.appendChild(actions);

    actions.querySelector('.btn-remove').addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/cards/${activeCardId}/personal/${p.id}`);
        await refreshCard();
      } catch (e) { showErr(e.message); }
    });

    list.appendChild(div);
  }
}

el('btn-add-personal').addEventListener('click', async () => {
  if (!activeCardId) return;
  const list = el('personal-picker-list');
  list.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:12px">Loading…</div>';
  el('modal-personal-picker').classList.remove('hidden');

  try {
    const items  = await api('GET', '/api/personal');
    const onCard = new Set((activeCard?.personal_items || []).map(p => p.folder_name));
    list.innerHTML = '';

    if (!items.length) {
      list.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:12px">No folders found in personal content store. Check NAS_PERSONAL_PATH in .env.</div>';
      return;
    }

    for (const item of items) {
      const added = onCard.has(item.folder_name);
      const div = document.createElement('div');
      div.className = 'personal-picker-item' + (added ? ' already-added' : '');
      div.innerHTML = `<span class="personal-picker-name">${esc(item.display_name)}</span>
        <span class="personal-picker-size">${fmt(item.size_bytes)}</span>
        <button class="btn-secondary small"${added ? ' disabled' : ''}>${added ? 'Added' : 'Add'}</button>`;

      if (!added) {
        div.querySelector('button').addEventListener('click', async e => {
          e.target.disabled = true;
          e.target.textContent = 'Adding…';
          try {
            await api('POST', `/api/cards/${activeCardId}/personal`, {
              folder_name:  item.folder_name,
              display_name: item.display_name,
            });
            await refreshCard();
            e.target.textContent = 'Added';
            div.classList.add('already-added');
            onCard.add(item.folder_name);
          } catch (err) {
            e.target.disabled = false;
            e.target.textContent = 'Add';
            showErr(err.message);
          }
        });
      }

      list.appendChild(div);
    }
  } catch (e) {
    list.innerHTML = `<div style="padding:14px;color:var(--danger);font-size:12px">Error: ${esc(e.message)}</div>`;
  }
});

// ── Tile grid ──────────────────────────────────────────────────────────────
function sortedResults() {
  return [...currentResults].sort((a, b) => {
    // Card-aware sorts: on-card albums first (by title), then off-card by secondary criterion
    if (sortBy === 'card_date' || sortBy === 'card_title' || sortBy === 'card_artist') {
      const aOn = a.on_card ? 0 : 1;
      const bOn = b.on_card ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;

      // On-card group: always by title
      if (a.on_card) {
        const cmp = a.title.localeCompare(b.title);
        return sortAsc ? cmp : -cmp;
      }

      // Off-card group: secondary criterion
      let cmp;
      if (sortBy === 'card_date') {
        const va = a.added_at ? new Date(a.added_at).getTime() : 0;
        const vb = b.added_at ? new Date(b.added_at).getTime() : 0;
        cmp = va - vb;
      } else if (sortBy === 'card_title') {
        cmp = a.title.localeCompare(b.title);
      } else {
        cmp = (a.artist || '').localeCompare(b.artist || '');
        if (cmp === 0) cmp = a.title.localeCompare(b.title);
      }
      return sortAsc ? cmp : -cmp;
    }

    let va, vb;
    switch (sortBy) {
      case 'title': va = a.title;      vb = b.title;      break;
      case 'year':  va = a.year || 0;  vb = b.year || 0;  break;
      case 'size':  va = a.size_bytes; vb = b.size_bytes;  break;
      case 'added': va = a.added_at ? new Date(a.added_at).getTime() : 0;
                    vb = b.added_at ? new Date(b.added_at).getTime() : 0; break;
      default:      va = a.artist;     vb = b.artist;      break;
    }
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });
}

function renderTileGrid() {
  const grid = el('search-results');
  grid.innerHTML = '';

  const rows      = sortedResults();
  const onCardIds = new Set((activeCard?.albums || []).map(a => a.album_id));

  el('search-count').textContent = rows.length ? `${rows.length} albums` : 'No results';

  for (const r of rows) {
    const isOnCard = r.on_card || onCardIds.has(r.id);
    const tile = document.createElement('div');
    tile.className = 'album-tile' + (isOnCard ? ' on-card' : '');
    tile.dataset.albumId = r.id;
    tile.title = `${r.artist} – ${r.title}${r.year ? ' ('+r.year+')' : ''}` +
                 `${r.genres ? '\n'+r.genres : ''}`;

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
      tile.addEventListener('click', async () => {
        if (!activeCardId) return;
        try {
          await api('DELETE', `/api/cards/${activeCardId}/albums/${r.id}`);
          await refreshCard();
          await doSearch();
        } catch (e) { showErr(e.message); }
      });
    } else {
      tile.addEventListener('click', async () => {
        if (!activeCardId) { alert('Select a card first.'); return; }
        try {
          await api('POST', `/api/cards/${activeCardId}/albums`, { album_id: r.id });
          await refreshCard();
          await doSearch();
        } catch (e) { showErr(e.message); }
      });
    }

    grid.appendChild(tile);
  }
}

// ── Sort controls ──────────────────────────────────────────────────────────
el('sort-by').addEventListener('change', () => { sortBy = el('sort-by').value; renderTileGrid(); });
el('btn-sort-dir').addEventListener('click', () => {
  sortAsc = !sortAsc;
  el('btn-sort-dir').textContent = sortAsc ? '↑' : '↓';
  renderTileGrid();
});

el('card-sort-by').addEventListener('change', () => { cardSortBy = el('card-sort-by').value; renderCardAlbums(); });
el('btn-card-sort-dir').addEventListener('click', () => {
  cardSortAsc = !cardSortAsc;
  el('btn-card-sort-dir').textContent = cardSortAsc ? '↑' : '↓';
  renderCardAlbums();
});

// ── Search / filters ───────────────────────────────────────────────────────
async function doSearch() {
  const q      = el('search-q').value.trim();
  const artist = el('search-artist').value.trim();
  const genre  = el('search-genre').value.trim();
  try {
    const params = new URLSearchParams({ limit: 20000 });
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

// ── Remove suggested albums ────────────────────────────────────────────────
el('btn-remove-suggestions').addEventListener('click', async () => {
  if (!activeCardId) return;
  const count = activeCard?.albums.filter(a => a.added_by === 'suggestion' && a.accepted).length || 0;
  if (!confirm(`Remove ${count} suggested album${count !== 1 ? 's' : ''} from this card?`)) return;
  try {
    await api('DELETE', `/api/cards/${activeCardId}/albums/suggestions`);
    await refreshCard(); await doSearch();
  } catch (e) { showErr(e.message); }
});

// ── Build ──────────────────────────────────────────────────────────────────
el('btn-build').addEventListener('click', async () => {
  if (!activeCardId) return;
  try {
    const pending = suggestions.filter(s => s._pending);
    if (pending.length) {
      await api('POST', `/api/cards/${activeCardId}/suggestions/accept`,
                { album_ids: pending.map(s => s.id) });
      suggestions.forEach(s => s._pending = false);
      el('suggestions-section').classList.add('hidden');
    }
    await api('POST', `/api/cards/${activeCardId}/build`);
    startBuildSSE();
  } catch (e) { showErr(e.message); }
});

function scrollToLog(sectionId) {
  el(sectionId).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

el('btn-jump-log').addEventListener('click', () => {
  const buildVisible = !el('build-section').classList.contains('hidden');
  scrollToLog(buildVisible ? 'build-section' : 'sync-section');
});

function startBuildSSE() {
  if (buildSSE) buildSSE.close();
  el('build-section').classList.remove('hidden');
  el('btn-jump-log').classList.remove('hidden');
  el('build-log').textContent = '';
  scrollToLog('build-section');
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
      buildSSE.close(); buildSSE = null;
      el('btn-jump-log').classList.add('hidden');
      refreshCard(); loadCards();
    }
  };
  buildSSE.onerror = () => { if (buildSSE) { buildSSE.close(); buildSSE = null; } };
}

// ── Sync to card ───────────────────────────────────────────────────────────
el('btn-sync').addEventListener('click', async () => {
  if (!activeCardId) return;
  if (!activeCard?.card_mount_path) {
    alert('Set a card mount path in Settings before syncing.');
    return;
  }
  const status  = activeCard?.stage_status || 'none';
  const missing = (activeCard?.staging_total || 0) - (activeCard?.staging_present || 0);
  if (status === 'none') {
    alert('Build the card first — no staged content found.');
    return;
  }
  if (missing > 0) {
    alert(`${missing} album${missing !== 1 ? 's' : ''} haven't been built to staging yet.\n\nRebuild before syncing to include them.`);
    return;
  }
  if (status === 'stale') {
    if (!confirm('Staging is out of date — card contents have changed since the last build.\n\nSync anyway with the old staging?')) return;
  }
  try {
    await api('POST', `/api/cards/${activeCardId}/sync`);
    startSyncSSE();
  } catch (e) { showErr(e.message); }
});

function startSyncSSE() {
  if (syncSSE) syncSSE.close();
  el('sync-section').classList.remove('hidden');
  el('btn-jump-log').classList.remove('hidden');
  el('sync-log').textContent = '';
  scrollToLog('sync-section');
  syncSSE = new EventSource(`/api/cards/${activeCardId}/sync/stream`);
  syncSSE.onmessage = e => {
    const d = JSON.parse(e.data);
    el('sync-bar').style.width = (d.pct || 0) + '%';
    el('sync-pct').textContent = (d.pct || 0) + '%';
    if (d.new_log?.length) {
      el('sync-log').textContent += d.new_log.join('\n') + '\n';
      el('sync-log').scrollTop = el('sync-log').scrollHeight;
    }
    if (d.status === 'done' || d.status === 'error') {
      syncSSE.close(); syncSSE = null;
      el('btn-jump-log').classList.add('hidden');
    }
  };
  syncSSE.onerror = () => { if (syncSSE) { syncSSE.close(); syncSSE = null; } };
}

function fmtDur(s) {
  return s < 60 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's';
}

// ── Card settings modal ────────────────────────────────────────────────────
el('btn-card-settings').addEventListener('click', () => {
  if (!activeCard) return;
  el('cfg-name').value          = activeCard.name;
  el('cfg-size').value          = activeCard.target_size_gb;
  el('cfg-output').value        = activeCard.card_mount_path || '';
  el('cfg-stage').value         = activeCard.stage_path || '(NAS_STAGE_PATH not configured)';
  el('cfg-profile').value       = activeCard.device_profile || 'generic';
  el('cfg-staging-mode').value  = activeCard.staging_mode || 'copy';
  el('modal-card-settings').classList.remove('hidden');
});

el('btn-save-settings').addEventListener('click', async () => {
  try {
    await api('PATCH', `/api/cards/${activeCardId}`, {
      name:            el('cfg-name').value.trim(),
      target_size_gb:  parseFloat(el('cfg-size').value),
      card_mount_path: el('cfg-output').value.trim(),
      device_profile:  el('cfg-profile').value,
      staging_mode:    el('cfg-staging-mode').value,
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

// ── Duplicate card ─────────────────────────────────────────────────────────
el('btn-duplicate-card').addEventListener('click', async () => {
  if (!activeCardId) return;
  try {
    const { id } = await api('POST', `/api/cards/${activeCardId}/duplicate`);
    el('modal-card-settings').classList.add('hidden');
    await loadCards();
    selectCard(id);
  } catch (e) { showErr(e.message); }
});

// ── Export card definition ─────────────────────────────────────────────────
el('btn-export-def').addEventListener('click', () => {
  if (!activeCardId) return;
  window.location.href = `/api/cards/${activeCardId}/export`;
});

// ── Import card definition modal ───────────────────────────────────────────
el('btn-import-def').addEventListener('click', () => {
  el('modal-card-settings').classList.add('hidden');
  el('import-def-result').classList.add('hidden');
  el('import-def-file').value = '';
  el('modal-import-definition').classList.remove('hidden');
});

el('btn-do-import-def').addEventListener('click', async () => {
  const file = el('import-def-file').files[0];
  if (!file) { alert('Select a JSON file.'); return; }

  const btn = el('btn-do-import-def');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  try {
    const data   = JSON.parse(await file.text());
    const result = await api('POST', '/api/cards/import-definition', data);

    const r = el('import-def-result');
    r.classList.remove('hidden');
    r.textContent = `✓ Created "${data.name}" with ${result.matched} album${result.matched !== 1 ? 's' : ''}.` +
      (result.unmatched > 0 ? ` ${result.unmatched} not found in library.` : '');

    await loadCards();
    selectCard(result.id);
    setTimeout(() => el('modal-import-definition').classList.add('hidden'), 2000);
  } catch (e) { showErr(e.message); }
  finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
});

// ── New card modal ─────────────────────────────────────────────────────────
el('btn-new-card').addEventListener('click', () => el('modal-new-card').classList.remove('hidden'));

el('btn-create-card').addEventListener('click', async () => {
  const name = el('new-card-name').value.trim();
  const size = parseFloat(el('new-card-size').value);
  if (!name || !size) { alert('Name and size are required.'); return; }
  try {
    const { id } = await api('POST', '/api/cards', {
      name,
      target_size_gb:  size,
      card_mount_path: el('new-card-output').value.trim(),
      device_profile:  el('new-card-profile').value,
      staging_mode:    el('new-card-staging-mode').value,
    });
    el('modal-new-card').classList.add('hidden');
    el('new-card-name').value   = '';
    el('new-card-size').value   = '32';
    el('new-card-output').value = '';
    await loadCards();
    selectCard(id);
  } catch (e) { showErr(e.message); }
});

// ── Import from physical card modal ────────────────────────────────────────
el('btn-import-card').addEventListener('click', () => {
  el('ic-result').classList.add('hidden');
  el('modal-import-card').classList.remove('hidden');
});

el('btn-do-import-card').addEventListener('click', async () => {
  const name  = el('ic-name').value.trim();
  const size  = parseFloat(el('ic-size').value);
  const mount = el('ic-mount').value.trim();
  if (!name || !size || !mount) { alert('Name, size and mount path are required.'); return; }

  const btn = el('btn-do-import-card');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const { id } = await api('POST', '/api/cards', {
      name,
      target_size_gb:  size,
      card_mount_path: mount,
      device_profile:  el('ic-profile').value,
    });

    btn.textContent = 'Scanning card…';
    const result = await api('POST', `/api/cards/${id}/import-card`);

    const r = el('ic-result');
    r.classList.remove('hidden');
    r.textContent = `✓ Matched ${result.matched} album${result.matched !== 1 ? 's' : ''}.` +
      (result.unmanaged > 0
        ? ` ${result.unmanaged} unmanaged folder${result.unmanaged !== 1 ? 's' : ''} flagged (preserved on sync).`
        : '');

    await loadCards();
    selectCard(id);
    setTimeout(() => el('modal-import-card').classList.add('hidden'), 2500);
  } catch (e) { showErr(e.message); }
  finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
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
initTileSlider();
loadCards();
doSearch();
