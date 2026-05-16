/* Media Card Builder – frontend */
'use strict';

const API = '';

// ── State ──────────────────────────────────────────────────────────────────
let activeCardId = null;
let activeCard = null;
let suggestions = [];
let buildSSE = null;
let searchTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────────
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
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => null);
}

function el(id) { return document.getElementById(id); }

function showErr(msg) {
  console.error(msg);
  alert('Error: ' + msg);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}

// ── Art lazy loading ───────────────────────────────────────────────────────
const artObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const tile = entry.target;
    if (tile.dataset.artLoaded) continue;
    tile.dataset.artLoaded = '1';
    const img = tile.querySelector('img.tile-img');
    if (!img) continue;
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => {
      img.style.display = 'none';
    };
    img.src = `/api/albums/${tile.dataset.albumId}/art`;
    artObserver.unobserve(tile);
  }
}, { rootMargin: '300px' });

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}

el('btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
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
  document.querySelectorAll('#card-list li').forEach(li => {
    li.classList.toggle('active', Number(li.dataset.id) === id);
  });
  el('no-card').classList.add('hidden');
  el('workspace').classList.remove('hidden');
  await refreshCard();
  // refresh search to show on-card indicators
  doSearch();
}

async function refreshCard() {
  if (!activeCardId) return;
  try {
    activeCard = await api('GET', `/api/cards/${activeCardId}`);
  } catch (e) {
    showErr(e.message);
    return;
  }
  renderCardSettings();
  renderCardAlbums();
  renderSpaceBar();
  renderStats();
}

// ── Card settings ──────────────────────────────────────────────────────────
function renderCardSettings() {
  const c = activeCard;
  el('card-name-display').textContent = c.name;
  el('cfg-name').value = c.name;
  el('cfg-size').value = c.target_size_gb;
  el('cfg-output').value = c.output_path || '';
  el('cfg-profile').value = c.device_profile || 'generic';
}

el('btn-save-settings').addEventListener('click', async () => {
  try {
    await api('PATCH', `/api/cards/${activeCardId}`, {
      name: el('cfg-name').value.trim(),
      target_size_gb: parseFloat(el('cfg-size').value),
      output_path: el('cfg-output').value.trim(),
      device_profile: el('cfg-profile').value,
    });
    await loadCards();
    await refreshCard();
  } catch (e) { showErr(e.message); }
});

// ── Stats & space bar ──────────────────────────────────────────────────────
function renderSpaceBar() {
  const c = activeCard;
  const target = c.target_bytes;
  const used = c.used_bytes;
  const suggestedBytes = suggestions
    .filter(s => s._pending)
    .reduce((a, s) => a + s.size_bytes, 0);
  const usedPct  = Math.min(used / target * 100, 100);
  const sugPct   = Math.min(suggestedBytes / target * 100, 100 - usedPct);
  el('space-used').style.width = usedPct + '%';
  el('space-suggested').style.width = sugPct + '%';
  el('space-used-label').textContent = fmt(used) + ' used';
  el('space-remaining-label').textContent =
    fmt(Math.max(target - used - suggestedBytes, 0)) + ' remaining of ' +
    c.target_size_gb + ' GB';
}

function renderStats() {
  const c = activeCard;
  const accepted = c.albums.filter(a => a.accepted);
  el('stat-albums').textContent = accepted.length;
  el('stat-used').textContent = fmt(c.used_bytes);
  el('stat-remaining').textContent = fmt(Math.max(c.target_bytes - c.used_bytes, 0));
  el('stat-status').textContent = c.status;
}

// ── Card albums list (with art thumbs) ─────────────────────────────────────
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
  div.dataset.albumId = a.album_id;
  if (!a.accepted) div.style.opacity = '0.45';

  const badge = a.added_by === 'suggestion'
    ? '<span class="badge-suggestion">suggest</span>' : '';

  div.innerHTML = `
    <img class="album-thumb" src="/api/albums/${a.album_id}/art"
         onerror="this.style.visibility='hidden'" alt="">
    <div class="album-info">
      <div class="album-title">${esc(a.title)}${badge}</div>
      <div class="album-sub">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}${a.genres ? ' · ' + esc(a.genres) : ''}</div>
    </div>
    <span class="album-size">${fmt(a.size_bytes)}</span>
    <div class="album-actions">
      <button class="icon-btn small btn-toggle-accept" title="${a.accepted ? 'Exclude' : 'Include'}">
        ${a.accepted ? '✓' : '○'}
      </button>
      <button class="icon-btn small btn-remove-album" title="Remove">✕</button>
    </div>`;

  div.querySelector('.btn-remove-album').addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/cards/${activeCardId}/albums/${a.album_id}`);
      await refreshCard();
      doSearch();
      renderSuggestions();
    } catch (e) { showErr(e.message); }
  });

  div.querySelector('.btn-toggle-accept').addEventListener('click', async () => {
    try {
      await api('PATCH', `/api/cards/${activeCardId}/albums/${a.album_id}`, { accepted: !a.accepted });
      await refreshCard();
    } catch (e) { showErr(e.message); }
  });

  return div;
}

// ── Album tile grid ────────────────────────────────────────────────────────
function renderSearchResults(rows) {
  const grid = el('search-results');
  grid.innerHTML = '';

  el('search-count').textContent = rows.length ? `${rows.length} albums` : 'No results';

  const onCardIds = new Set(
    (activeCard?.albums || []).map(a => a.album_id)
  );

  for (const r of rows) {
    const tile = document.createElement('div');
    const isOnCard = r.on_card || onCardIds.has(r.id);
    tile.className = 'album-tile' + (isOnCard ? ' on-card' : '');
    tile.dataset.albumId = r.id;
    tile.title = `${r.artist} – ${r.title}${r.year ? ' (' + r.year + ')' : ''}${r.genres ? '\n' + r.genres : ''}\n${fmt(r.size_bytes)}`;

    tile.innerHTML = `
      <div class="art-placeholder"></div>
      <img class="tile-img" alt="">
      <div class="album-tile-overlay">
        <div class="album-tile-title">${esc(r.title)}</div>
        <div class="album-tile-artist">${esc(r.artist)}</div>
      </div>
      ${isOnCard ? '<div class="tile-check">✓</div>' : ''}`;

    if (!isOnCard) {
      const handler = async () => {
        if (!activeCardId) { alert('Select a card first.'); return; }
        try {
          await api('POST', `/api/cards/${activeCardId}/albums`, { album_id: r.id });
          tile.classList.add('on-card');
          tile.removeEventListener('click', handler);
          if (!tile.querySelector('.tile-check')) {
            const chk = document.createElement('div');
            chk.className = 'tile-check';
            chk.textContent = '✓';
            tile.appendChild(chk);
          }
          await refreshCard();
        } catch (e) { showErr(e.message); }
      };
      tile.addEventListener('click', handler);
    }

    artObserver.observe(tile);
    grid.appendChild(tile);
  }
}

// ── Search / filter ────────────────────────────────────────────────────────
async function doSearch() {
  const q = el('search-q').value.trim();
  const artist = el('search-artist').value.trim();
  const genre = el('search-genre').value.trim();
  try {
    const params = new URLSearchParams({ limit: 300 });
    if (q) params.set('q', q);
    if (artist) params.set('artist', artist);
    if (genre) params.set('genre', genre);
    if (activeCardId) params.set('card_id', activeCardId);
    const rows = await api('GET', `/api/albums/search?${params}`);
    renderSearchResults(rows);
  } catch (e) { showErr(e.message); }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 350);
}

el('search-q').addEventListener('input', scheduleSearch);
el('search-artist').addEventListener('input', scheduleSearch);
el('search-genre').addEventListener('input', scheduleSearch);

// ── Suggestions ────────────────────────────────────────────────────────────
el('btn-suggest').addEventListener('click', async () => {
  if (!activeCardId) return;
  try {
    const res = await api('GET', `/api/cards/${activeCardId}/suggestions`);
    suggestions = res.suggestions.map(s => ({ ...s, _pending: true }));
    renderSuggestions();
    renderSpaceBar();
  } catch (e) { showErr(e.message); }
});

function renderSuggestions() {
  const sec = el('suggestions-section');
  const list = el('suggestions-list');
  const pending = suggestions.filter(s => s._pending);
  if (!pending.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  list.innerHTML = '';

  for (const s of pending) {
    const div = document.createElement('div');
    div.className = 'album-item';
    div.innerHTML = `
      <img class="album-thumb" src="/api/albums/${s.id}/art"
           onerror="this.style.visibility='hidden'" alt="">
      <div class="album-info">
        <div class="album-title">${esc(s.title)}</div>
        <div class="album-sub">${esc(s.artist)}${s.year ? ' · ' + s.year : ''}${s.genres ? ' · ' + esc(s.genres) : ''}</div>
      </div>
      <span class="album-size">${fmt(s.size_bytes)}</span>
      <div class="album-actions">
        <button class="icon-btn small btn-accept-one" title="Accept">✓</button>
        <button class="icon-btn small btn-reject-one" title="Reject">✕</button>
      </div>`;

    div.querySelector('.btn-accept-one').addEventListener('click', async () => {
      try {
        await api('POST', `/api/cards/${activeCardId}/suggestions/accept`, { album_ids: [s.id] });
        s._pending = false;
        await refreshCard();
        renderSuggestions();
        doSearch();
      } catch (e) { showErr(e.message); }
    });

    div.querySelector('.btn-reject-one').addEventListener('click', () => {
      s._pending = false;
      renderSuggestions();
      renderSpaceBar();
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
    await refreshCard();
    renderSuggestions();
    doSearch();
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
  const outputPath = el('cfg-output').value.trim();
  if (!outputPath) { alert('Set an output path before building.'); return; }
  try {
    await api('PATCH', `/api/cards/${activeCardId}`, {
      name: el('cfg-name').value.trim(),
      target_size_gb: parseFloat(el('cfg-size').value),
      output_path: outputPath,
      device_profile: el('cfg-profile').value,
    });
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
    el('build-bar').style.width = (d.pct || 0) + '%';
    el('build-pct').textContent = (d.pct || 0) + '%';
    el('build-eta').textContent = d.eta_secs != null ? 'ETA ' + fmtDuration(d.eta_secs) : '';
    el('build-current').textContent = d.current_album || '';
    if (d.new_log && d.new_log.length) {
      el('build-log').textContent += d.new_log.join('\n') + '\n';
      el('build-log').scrollTop = el('build-log').scrollHeight;
    }
    if (d.status === 'done' || d.status === 'error') {
      buildSSE.close(); buildSSE = null;
      refreshCard();
    }
  };
  buildSSE.onerror = () => { if (buildSSE) { buildSSE.close(); buildSSE = null; } };
}

function fmtDuration(secs) {
  if (secs < 60) return secs + 's';
  return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
}

// ── New card modal ──────────────────────────────────────────────────────────
el('btn-new-card').addEventListener('click', () => el('modal-new-card').classList.remove('hidden'));
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
});
el('modal-new-card').addEventListener('click', e => {
  if (e.target === el('modal-new-card')) el('modal-new-card').classList.add('hidden');
});

el('btn-create-card').addEventListener('click', async () => {
  const name = el('new-card-name').value.trim();
  const size = parseFloat(el('new-card-size').value);
  const output = el('new-card-output').value.trim();
  const profile = el('new-card-profile').value;
  if (!name || !size) { alert('Name and size are required.'); return; }
  try {
    const { id } = await api('POST', '/api/cards', {
      name, target_size_gb: size, output_path: output, device_profile: profile,
    });
    el('modal-new-card').classList.add('hidden');
    el('new-card-name').value = '';
    el('new-card-size').value = '32';
    el('new-card-output').value = '';
    await loadCards();
    selectCard(id);
  } catch (e) { showErr(e.message); }
});

// ── Delete card ────────────────────────────────────────────────────────────
el('btn-delete-card').addEventListener('click', async () => {
  if (!activeCardId) return;
  if (!confirm(`Delete card "${activeCard?.name}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/cards/${activeCardId}`);
    activeCardId = null; activeCard = null;
    el('workspace').classList.add('hidden');
    el('no-card').classList.remove('hidden');
    await loadCards();
  } catch (e) { showErr(e.message); }
});

// ── Init ───────────────────────────────────────────────────────────────────
loadCards();
doSearch();
