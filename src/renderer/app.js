'use strict';
/* global bdl */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;

const S = {
  settings: {},
  formats: {},
  layouts: {},
  browsers: [],
  tabs: { activeId: null, tabs: [] },
  media: null,
  queue: [],
  library: [],
  view: 'browse',
  picks: new Map(), // catch-panel tick overrides, keyed per page
  picksPage: null,
  folderEdits: new Map(), // page url -> folder the user typed
  sublist: null, // a list opened from the page (a channel's "Videos", say)
  lastFound: 0,
  lib: { type: 'all', q: '', sort: 'new', site: null, coll: null, sel: new Set() },
};

// ---------- formatting ----------

function fmtSize(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function fmtDur(s) {
  if (!s || !Number.isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function fmtEta(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))}s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}
function fmtWhen(t) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const dec = decodeURIComponent(last);
    const dot = dec.lastIndexOf('.');
    return (dot > 0 ? dec.slice(0, dot) : dec).replace(/[_+]+/g, ' ').trim() || null;
  } catch { return null; }
}
// Names like "index" or a long hash say nothing; the page title is better then.
function isGenericName(n) {
  return !n || n.length < 2 || /^(index|master|manifest|playlist|chunklist|video|audio|media|stream|file|download|play|source|output|default|main|hls|dash)$/i.test(n) ||
    /^[0-9a-f-]{16,}$/i.test(n) || /^\d+$/.test(n);
}
/** What a caught item is called in the list, and the file name it's saved under. */
function itemName(x, pageTitle) {
  const fromUrl = nameFromUrl(x.url);
  return x.label || (!isGenericName(fromUrl) ? fromUrl : null) || pageTitle || fromUrl || 'Download';
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function optionList(map, selected) {
  return Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${String(k) === String(selected) ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

// ---------- status bar and toasts ----------

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#st-msg');
  el.textContent = message;
  el.className = `msg toast${kind === 'bad' ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastTimer = null; renderStatus(); }, 5000);
}

function renderStatus() {
  const running = S.queue.filter((i) => i.status === 'running');
  const waiting = S.queue.filter((i) => i.status === 'queued').length;
  const active = running.length + waiting;
  const badge = $('#queue-badge');
  badge.hidden = !active;
  badge.textContent = active;
  $('#st-stop').hidden = !active;
  const meter = $('#st-meter');
  meter.hidden = !running.length;
  if (running.length) {
    const p = running.reduce((a, i) => a + (i.progress || 0), 0) / running.length;
    meter.firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }
  if (toastTimer) return;
  const el = $('#st-msg');
  el.className = 'msg';
  if (!active) {
    const failed = S.queue.filter((i) => i.status === 'failed').length;
    el.textContent = failed ? `${failed} download${failed > 1 ? 's' : ''} failed. See Queue.` : 'Nothing downloading';
    return;
  }
  const speed = running.reduce((a, i) => a + (i.speed || 0), 0);
  el.textContent = `Downloading ${running.length}${waiting ? `, ${waiting} waiting` : ''}${speed ? ` at ${fmtSize(speed)}/s` : ''}`;
}

// ---------- views ----------

function showView(name) {
  S.view = name;
  for (const v of ['browse', 'queue', 'library', 'settings']) $(`#view-${v}`).hidden = v !== name;
  for (const b of $$('.nav')) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  reportBounds();
  if (name === 'library') renderLibrary();
  if (name === 'queue') renderQueue();
  if (name === 'settings') loadVersions();
  bdl.invoke('settings:set', { lastView: name });
}

function reportBounds() {
  if (S.view !== 'browse') {
    bdl.invoke('browser:bounds', null);
    return;
  }
  const r = $('#viewport').getBoundingClientRect();
  bdl.invoke('browser:bounds', { x: r.left, y: r.top, width: r.width, height: r.height });
}

// ---------- browse: tabs and toolbar ----------

function activeTab() {
  return S.tabs.tabs.find((t) => t.id === S.tabs.activeId) || null;
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = S.tabs.tabs.map((t) => `
    <div class="tab${t.loading ? ' loading' : ''}" role="tab" aria-selected="${t.id === S.tabs.activeId}" data-id="${t.id}" title="${esc(t.title)}">
      ${t.favicon && !t.loading ? `<img class="fav" src="${esc(t.favicon)}" alt="">` : `<span class="fav blank"></span>`}
      <span class="t">${esc(t.title)}</span>
      ${t.found ? `<span class="count" title="Media found">${t.found}</span>` : ''}
      <button class="x" data-close="${t.id}" title="Close tab">${icon('x')}</button>
    </div>`).join('') + `<button class="btn quiet icon newtab" id="tab-new" title="New tab">${icon('plus')}</button>`;
  for (const img of $$('img.fav', el)) img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'fav blank' }));
  const t = activeTab();
  $('#nav-back').disabled = !t || !t.canGoBack;
  $('#nav-forward').disabled = !t || !t.canGoForward;
  const reload = $('#nav-reload');
  reload.innerHTML = icon(t && t.loading ? 'x' : 'reload');
  reload.title = t && t.loading ? 'Stop' : 'Reload';
  const addr = $('#address');
  if (document.activeElement !== addr) addr.value = t ? t.url : '';
  const found = t ? t.found : 0;
  const btn = $('#catch-toggle');
  $('#catch-count').textContent = found;
  btn.classList.toggle('has', found > 0);
  if (found > S.lastFound) {
    btn.classList.remove('bump');
    void btn.offsetWidth;
    btn.classList.add('bump');
  }
  S.lastFound = found;
}

$('#tabs').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { bdl.invoke('tab:close', Number(close.dataset.close)); return; }
  if (e.target.closest('#tab-new')) { bdl.invoke('tab:new'); setTimeout(() => $('#address').focus(), 50); return; }
  const tab = e.target.closest('.tab');
  if (tab) bdl.invoke('tab:activate', Number(tab.dataset.id));
});
$('#tabs').addEventListener('auxclick', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && e.button === 1) bdl.invoke('tab:close', Number(tab.dataset.id));
});
$('#nav-back').onclick = () => bdl.invoke('tab:go', S.tabs.activeId, 'back');
$('#nav-forward').onclick = () => bdl.invoke('tab:go', S.tabs.activeId, 'forward');
$('#nav-reload').onclick = () => bdl.invoke('tab:go', S.tabs.activeId, activeTab() && activeTab().loading ? 'stop' : 'reload');
$('#address-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#address').value.trim();
  if (!v) return;
  bdl.invoke('tab:navigate', S.tabs.activeId, v);
  $('#address').blur();
};
$('#address').addEventListener('focus', () => $('#address').select());
$('#address').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const t = activeTab(); $('#address').value = t ? t.url : ''; $('#address').blur(); }
});
$('#catch-toggle').onclick = () => setCatchOpen(!S.settings.catchOpen);

function setCatchOpen(open) {
  S.settings.catchOpen = open;
  $('#catch').hidden = !open;
  $('#catch-toggle').setAttribute('aria-pressed', String(open));
  bdl.invoke('settings:set', { catchOpen: open });
  requestAnimationFrame(reportBounds);
}

// ---------- browse: the catch panel ----------

function pickKey(kind, id) { return `${kind}:${id}`; }

function catchRows() {
  // What the panel lists right now, with whether each is ticked.
  const m = S.media;
  const rows = [];
  if (!m) return rows;
  if (S.sublist) {
    (S.sublist.entries || []).forEach((e, i) => rows.push({ type: 'entry', key: pickKey('s', entryId(e)), e, done: S.sublist.downloaded && S.sublist.downloaded[i], extractor: S.sublist.extractor }));
  } else {
    if (m.scan && m.scan.status === 'done') {
      m.scan.entries.forEach((e, i) => rows.push({ type: 'entry', key: pickKey('e', entryId(e)), e, done: m.downloaded && m.downloaded.entries[i], extractor: m.scan.extractor }));
    }
    m.media.forEach((x, i) => rows.push({ type: 'media', key: pickKey('m', x.key), x, done: m.downloaded && m.downloaded.media[i] }));
    const groups = m.linked && m.linked.groups ? m.linked.groups : [];
    const listed = new Set(rows.filter((r) => r.type === 'entry').map((r) => r.e.url));
    groups.forEach((g, gi) => g.links.forEach((l, li) => {
      if (listed.has(l.url) || l.url === m.pageUrl) return;
      rows.push({ type: 'linked', group: gi, label: g.label, key: pickKey('l', l.url), l, done: m.downloaded && m.downloaded.linked && m.downloaded.linked[gi] && m.downloaded.linked[gi][li] });
    }));
  }
  for (const r of rows) {
    const blocked = r.type === 'entry' ? r.e.isList || r.e.live : r.type === 'media' ? r.x.drm : false;
    r.blocked = blocked;
    // Linked pages start unticked: a listing page can link to a lot.
    const byDefault = r.type === 'linked' ? false : !blocked && !r.done;
    r.on = S.picks.has(r.key) ? S.picks.get(r.key) && !blocked : byDefault;
  }
  return rows;
}

// Works of one list can share a URL, so they're told apart by their position.
function entryId(e) {
  return e.playlistItem ? `${e.url}#${e.playlistItem}` : e.url;
}

function defaultFolder() {
  const m = S.media;
  if (!m) return '';
  if (S.folderEdits.has(m.pageUrl)) return S.folderEdits.get(m.pageUrl);
  if (S.sublist) return S.sublist.title || '';
  if (m.scan && m.scan.status === 'done') {
    if (m.scan.title) return m.scan.title;
    const e = m.scan.entries[0];
    if (m.scan.entries.length === 1 && e && e.uploader) return e.uploader;
  }
  return m.pageTitle || '';
}

function renderCatch() {
  const m = S.media;
  const list = $('#catch-list');
  if (!m) { list.innerHTML = ''; return; }
  if (S.picksPage !== m.pageUrl) {
    S.picks.clear();
    S.picksPage = m.pageUrl;
    S.sublist = null;
  }
  $('#catch-title').textContent = S.sublist ? S.sublist.title || 'List' : 'Found on this page';
  $('#catch-site').textContent = m.site || '';
  const rows = catchRows();
  const folder = $('#catch-folder');
  if (document.activeElement !== folder) folder.value = defaultFolder();

  let html = '';
  if (S.sublist) {
    html += `<div class="group-head"><button class="btn quiet" id="sub-back">${icon('back')}Back to page</button><span class="gt"></span></div>`;
    if (S.sublist.loading) html += `<div class="scanning"><span class="spinner"></span>Listing everything in ${esc(S.sublist.title || 'this list')}…</div>`;
    else if (S.sublist.error) html += `<div class="catch-empty"><p>${esc(S.sublist.error)}</p></div>`;
    else html += groupHtml(`${S.sublist.entries.length} item${S.sublist.entries.length === 1 ? '' : 's'}`, rows, 'entry');
  } else {
    const scan = m.scan || {};
    if (scan.status === 'scanning') html += `<div class="scanning"><span class="spinner"></span>Checking this page with yt-dlp…</div>`;
    if (scan.status === 'error' && scan.error && !/No media found/.test(scan.error)) {
      html += `<div class="group-note">Couldn't list this page's videos: ${esc(scan.error)}</div>`;
    }
    const entries = rows.filter((r) => r.type === 'entry');
    if (entries.length) {
      const label = scan.title ? scan.title : entries.length === 1 ? 'This page' : `${entries.length} on this page`;
      html += groupHtml(label, entries, 'entry');
    }
    const caught = rows.filter((r) => r.type === 'media');
    if (caught.length) html += groupHtml(`Playing or linked here`, caught, 'media');
    const linked = rows.filter((r) => r.type === 'linked');
    const byGroup = new Map();
    for (const r of linked) {
      if (!byGroup.has(r.group)) byGroup.set(r.group, []);
      byGroup.get(r.group).push(r);
    }
    for (const [gi, list] of byGroup) {
      const label = list[0].label;
      html += groupHtml(`Linked ${label} pages (${list.length})`, list, `linked:${gi}`,
        'Each one is a page with its own videos. Tick the ones you want; a page with several works saves them into a folder of its own.');
    }
    const linkedState = m.linked || {};
    if (linkedState.status === 'checking') html += `<div class="scanning"><span class="spinner"></span>Checking the links on this page…</div>`;
    if (!entries.length && !caught.length && !linked.length && scan.status !== 'scanning' && linkedState.status !== 'checking') {
      html += `<div class="catch-empty">
        <h3>Nothing found yet</h3>
        <p>Press play on a video or song and it'll show up here as it loads. Pages with links to audio or video files list them too.</p>
        <p>Need to log in first? Do it right here in the page; browseDL remembers it for downloads.</p>
      </div>`;
    }
  }
  list.innerHTML = html;
  for (const img of $$('img', list)) img.onerror = () => { img.remove(); };
  const n = rows.filter((r) => r.on).length;
  const go = $('#catch-go');
  go.disabled = !n;
  go.textContent = n ? `Download ${n}` : 'Download';
  $('#catch-foot').hidden = !rows.length;
}

function groupHtml(label, rows, type, note) {
  const allOn = rows.filter((r) => !r.blocked).every((r) => r.on);
  return `<div class="group">
    <div class="group-head"><span class="gt">${esc(label)}</span>
      ${rows.length > 1 || type.startsWith('linked') ? `<button class="btn quiet" data-all="${type}" data-on="${allOn ? 0 : 1}">${allOn ? 'Untick all' : 'Tick all'}</button>` : ''}
    </div>
    ${note ? `<div class="group-note">${esc(note)}</div>` : ''}
    ${rows.map(rowHtml).join('')}
  </div>`;
}

function rowHtml(r) {
  if (r.type === 'linked') {
    const l = r.l;
    let path = l.url;
    try { const u = new URL(l.url); path = u.pathname + u.search; } catch { /* keep */ }
    return `<label class="pick${r.on ? ' on' : ''}${r.done ? ' dim' : ''}" data-key="${esc(r.key)}" title="${esc(l.url)}">
      <input type="checkbox" ${r.on ? 'checked' : ''}>
      <div class="thumb">${icon('link')}</div>
      <div class="body"><div class="title">${esc(l.title || path)}</div>
        <div class="meta">${r.done ? '<span class="tag done">Downloaded</span>' : ''}<span class="url">${esc(path)}</span></div></div>
    </label>`;
  }
  if (r.type === 'entry') {
    const e = r.e;
    const tags = [];
    if (e.duration) tags.push(`<span>${fmtDur(e.duration)}</span>`);
    if (e.uploader) tags.push(`<span>${esc(e.uploader)}</span>`);
    if (e.live) tags.push(`<span class="tag live">Live or upcoming</span>`);
    if (e.availability && /premium|subscriber|needs_auth/.test(e.availability)) tags.push(`<span class="tag">Members</span>`);
    if (r.done) tags.push(`<span class="tag done">Downloaded</span>`);
    if (e.isList) {
      return `<div class="pick" data-key="${esc(r.key)}" data-list="${esc(e.url)}" data-title="${esc(e.title)}">
        <span></span>
        <div class="thumb">${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="" loading="lazy">` : icon('list')}</div>
        <div class="body"><div class="title">${esc(e.title)}</div><div class="meta"><span>A list</span></div>
          <button class="btn open" data-open="${esc(e.url)}">Show what's in it</button></div>
      </div>`;
    }
    return `<label class="pick${r.on ? ' on' : ''}${r.done ? ' dim' : ''}" data-key="${esc(r.key)}">
      <input type="checkbox" ${r.on ? 'checked' : ''} ${r.blocked ? 'disabled' : ''}>
      <div class="thumb">${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="" loading="lazy">` : icon('video')}</div>
      <div class="body"><div class="title">${esc(e.title)}</div><div class="meta">${tags.join('')}</div></div>
    </label>`;
  }
  const x = r.x;
  const title = itemName(x, S.media && S.media.pageTitle);
  const tags = [];
  if (x.kind === 'hls') tags.push(`<span class="tag">Stream${x.height ? ` ${x.height}p` : ''}</span>`);
  else if (x.kind === 'dash') tags.push(`<span class="tag">DASH stream</span>`);
  else if (x.ext) tags.push(`<span class="tag">${esc(x.ext.toUpperCase())}</span>`);
  if (x.size) tags.push(`<span>${fmtSize(x.size)}</span>`);
  if (x.duration) tags.push(`<span>${fmtDur(x.duration)}</span>`);
  if (x.seenPlaying) tags.push(`<span class="tag live">Loaded by page</span>`);
  else if (x.source === 'link') tags.push(`<span>Linked</span>`);
  if (x.drm) tags.push(`<span class="tag bad">DRM, can't be saved</span>`);
  if (r.done) tags.push(`<span class="tag done">Downloaded</span>`);
  const ic = x.media === 'audio' ? 'audio' : x.kind === 'file' ? 'video' : 'stream';
  return `<label class="pick${r.on ? ' on' : ''}${r.done || x.drm ? ' dim' : ''}" data-key="${esc(r.key)}" title="${esc(x.url)}">
    <input type="checkbox" ${r.on ? 'checked' : ''} ${r.blocked ? 'disabled' : ''}>
    <div class="thumb">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : icon(ic)}</div>
    <div class="body"><div class="title">${esc(title)}</div><div class="meta">${tags.join('')}</div></div>
  </label>`;
}

$('#catch-list').addEventListener('change', (e) => {
  const pick = e.target.closest('.pick');
  if (!pick || e.target.type !== 'checkbox') return;
  S.picks.set(pick.dataset.key, e.target.checked);
  renderCatch();
});
$('#catch-list').addEventListener('click', async (e) => {
  const all = e.target.closest('[data-all]');
  if (all) {
    const on = all.dataset.on === '1';
    const [type, group] = all.dataset.all.split(':');
    for (const r of catchRows()) {
      if (r.type === type && !r.blocked && (group === undefined || String(r.group) === group)) S.picks.set(r.key, on);
    }
    renderCatch();
    return;
  }
  if (e.target.closest('#sub-back')) { S.sublist = null; renderCatch(); return; }
  const open = e.target.closest('[data-open]');
  if (open) {
    const row = open.closest('.pick');
    openSublist(open.dataset.open, row ? row.dataset.title : null);
  }
});

async function openSublist(url, title) {
  S.sublist = { url, title, loading: true, entries: [] };
  renderCatch();
  const r = await bdl.invoke('scan:list', url);
  if (!S.sublist || S.sublist.url !== url) return;
  if (r.ok) {
    S.sublist = { url, title: r.title || title, extractor: r.extractor, entries: r.entries.filter((e) => !e.isList), downloaded: r.downloaded ? r.downloaded.filter((_, i) => !r.entries[i].isList) : [], loading: false };
    if (!S.sublist.entries.length) S.sublist.error = 'This list is empty.';
  } else {
    S.sublist = { url, title, loading: false, entries: [], error: r.error || 'Couldn\'t list this.' };
  }
  renderCatch();
}

$('#catch-folder').addEventListener('input', () => {
  if (S.media) S.folderEdits.set(S.media.pageUrl, $('#catch-folder').value);
});
$('#catch-rescan').onclick = () => { S.sublist = null; bdl.invoke('tab:rescan', S.tabs.activeId); };

$('#catch-go').onclick = async () => {
  const m = S.media;
  if (!m) return;
  const format = $('#catch-format').value;
  const collection = $('#catch-folder').value.trim() || null;
  const root = saveInValue('#catch-dir');
  const items = [];
  for (const r of catchRows()) {
    if (!r.on) continue;
    if (r.type === 'entry') {
      const e = r.e;
      items.push({ url: e.url, title: e.title, kind: 'page', pageUrl: e.url, thumbnail: e.thumbnail, duration: e.duration, collection, format, id: e.id, extractor: r.extractor, site: m.site, playlistItem: e.playlistItem || null, root });
    } else if (r.type === 'linked') {
      items.push({ url: r.l.url, title: r.l.title || r.l.url, kind: 'page', pageUrl: r.l.url, collection, format, site: m.site, multi: true, root });
    } else {
      const x = r.x;
      const name = itemName(x, m.pageTitle);
      items.push({
        url: x.url, kind: x.kind, media: x.media, title: name, name, pageUrl: x.pageUrl || m.pageUrl, headers: x.headers,
        size: x.size, duration: x.duration, thumbnail: x.poster, collection, format, site: m.site, root,
      });
    }
  }
  if (!items.length) return;
  const r = await bdl.invoke('queue:add', items, {});
  const parts = [];
  if (r.added) parts.push(`Added ${r.added} to the queue`);
  if (r.already) parts.push(`${r.already} already in your library, skipped`);
  if (r.dupes) parts.push(`${r.dupes} already queued`);
  toast(parts.join('. ') || 'Nothing new to add');
  for (const row of catchRows()) if (row.on) S.picks.set(row.key, false);
  renderCatch();
};

// ---------- where downloads go ----------

const CHOOSE = '__choose_folder__';
function shortDir(d) {
  const parts = String(d).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${S.platform === 'win32' ? '\\' : '/'}${parts.slice(-2).join(S.platform === 'win32' ? '\\' : '/')}` : d;
}
/** Fill a "Save in" list: the default folder, recent ones, and a way to pick another. */
function renderSaveIn(sel) {
  const el = $(sel);
  const cur = el.dataset.value || '';
  const dirs = (S.settings.recentDirs || []).filter((d) => d !== S.settings.downloadDir);
  el.innerHTML = `<option value="">${esc(shortDir(S.settings.downloadDir))} (default)</option>` +
    dirs.map((d) => `<option value="${esc(d)}" title="${esc(d)}">${esc(shortDir(d))}</option>`).join('') +
    `<option value="${CHOOSE}">Choose a folder…</option>`;
  el.value = dirs.includes(cur) ? cur : '';
  el.dataset.value = el.value;
  el.title = el.value || S.settings.downloadDir;
}
function saveInValue(sel) {
  return $(sel).dataset.value || null;
}
for (const sel of ['#catch-dir', '#addlinks-dir']) {
  $(sel).addEventListener('change', async (e) => {
    const el = e.target;
    let value = el.value;
    if (value === CHOOSE) {
      const dir = await bdl.invoke('folder:choose');
      value = dir || el.dataset.value || '';
      if (dir && dir !== S.settings.downloadDir) S.settings.recentDirs = [dir, ...(S.settings.recentDirs || []).filter((d) => d !== dir)];
    }
    el.dataset.value = value;
    renderSaveIn('#catch-dir');
    renderSaveIn('#addlinks-dir');
  });
}

// ---------- queue ----------

function queueRowHtml(i) {
  const audioFormat = /^(mp3|m4a|audio)$/.test(i.format);
  const fmt = i.media === 'audio' && !audioFormat ? 'Audio as it is' : S.formats[i.format] || i.format;
  const where = [i.site, i.collection].filter(Boolean).join(' › ');
  const thumb = i.thumbnail ? `<img src="${esc(i.thumbnail)}" alt="" loading="lazy">` : icon(i.media === 'audio' || /mp3|m4a|audio/.test(i.format) ? 'audio' : 'video');
  return `<div class="qrow ${i.status}" data-id="${i.id}">
    <div class="fill"></div>
    <div class="thumb">${thumb}</div>
    <div class="main">
      <div class="title" title="${esc(i.title)}">${esc(i.title)}</div>
      ${i.status === 'failed' && i.error ? `<div class="err">${esc(i.error)}</div>` : `<div class="sub">${esc(where)}${where ? ' — ' : ''}${esc(fmt)}</div>`}
    </div>
    <div class="state"></div>
    <div class="acts">${queueActs(i)}</div>
  </div>`;
}

function queueActs(i) {
  const b = (act, ic, title) => `<button class="btn quiet icon" data-act="${act}" title="${title}">${icon(ic)}</button>`;
  switch (i.status) {
    case 'running': return b('pause', 'pause', 'Pause') + b('stop', 'stop', 'Stop');
    case 'queued': return b('top', 'top', 'Download next') + b('pause', 'pause', 'Pause') + b('remove', 'x', 'Remove');
    case 'paused': return b('resume', 'play', 'Resume') + b('remove', 'x', 'Remove');
    case 'failed':
    case 'stopped': return b('retry', 'retry', 'Retry') + (i.pageUrl ? b('page', 'link', 'Open the page') : '') + b('remove', 'x', 'Remove');
    case 'done': return b('play', 'play', 'Play') + b('reveal', 'folder', 'Show in folder') + b('remove', 'x', 'Remove from list');
    default: return '';
  }
}

function queueStateText(i) {
  switch (i.status) {
    case 'running': {
      const pct = i.progress != null ? `<span class="pct">${Math.floor(i.progress * 100)}%</span><br>` : '';
      const bits = [i.phase || 'Starting', i.speed ? `${fmtSize(i.speed)}/s` : '', fmtEta(i.eta)].filter(Boolean);
      return pct + esc(bits.join(', '));
    }
    case 'queued': return 'Waiting';
    case 'paused': return i.progress ? `Paused at ${Math.floor(i.progress * 100)}%` : 'Paused';
    case 'done': return `Done${i.files && i.files.length > 1 ? `, ${i.files.length} files` : ''}${i.size ? `, ${fmtSize(i.size)}` : ''}`;
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
    default: return esc(i.status);
  }
}

function updateQueueRow(el, i) {
  el.className = `qrow ${i.status}`;
  $('.fill', el).style.width = i.status === 'running' || i.status === 'paused' ? `${Math.round((i.progress || 0) * 100)}%` : '0';
  $('.state', el).innerHTML = queueStateText(i);
}

function renderQueue() {
  const list = $('#q-list');
  const c = { running: 0, queued: 0, paused: 0, done: 0, failed: 0, stopped: 0 };
  for (const i of S.queue) c[i.status] = (c[i.status] || 0) + 1;
  $('#q-summary').innerHTML = S.queue.length
    ? [['Downloading', c.running], ['Waiting', c.queued], ['Paused', c.paused], ['Done', c.done], ['Failed', c.failed + c.stopped]]
      .filter(([, n]) => n).map(([l, n]) => `<span>${l} <b>${n}</b></span>`).join('')
    : '';
  $('#q-pause-all').disabled = !(c.running + c.queued);
  $('#q-resume-all').disabled = !c.paused;
  $('#q-stop-waiting').disabled = !(c.queued + c.paused);
  $('#q-retry-all').disabled = !(c.failed + c.stopped);
  $('#q-clear').disabled = !c.done;
  if (!S.queue.length) {
    list.innerHTML = `<div class="empty"><h3>The queue is empty</h3><p>Find something in Browse and press Download, or paste links here.</p>
      <button class="btn" id="q-empty-add">${icon('plus')}Add links</button></div>`;
    renderStatus();
    return;
  }
  // Running first, then waiting, paused, problems, and finished last (newest first).
  const order = { running: 0, queued: 1, paused: 2, failed: 3, stopped: 3, done: 4 };
  const sorted = S.queue.map((i, n) => [i, n]).sort((a, b) => (order[a[0].status] - order[b[0].status]) || (a[0].status === 'done' ? (b[0].finishedAt || 0) - (a[0].finishedAt || 0) : a[1] - b[1])).map(([i]) => i);
  list.innerHTML = sorted.map(queueRowHtml).join('');
  for (const el of $$('.qrow', list)) updateQueueRow(el, S.queue.find((i) => i.id === el.dataset.id));
  for (const img of $$('img', list)) img.onerror = () => img.remove();
  renderStatus();
}

function patchQueue(items) {
  let structural = false;
  for (const it of items) {
    const n = S.queue.findIndex((i) => i.id === it.id);
    if (n < 0) continue;
    if (S.queue[n].status !== it.status) structural = true;
    S.queue[n] = it;
    if (S.view === 'queue' && !structural) {
      const el = $(`.qrow[data-id="${it.id}"]`);
      if (el) updateQueueRow(el, it);
    }
  }
  if (structural && S.view === 'queue') renderQueue();
  renderStatus();
}

$('#q-list').addEventListener('click', (e) => {
  if (e.target.closest('#q-empty-add')) { toggleAddLinks(true); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.qrow').dataset.id;
  const item = S.queue.find((i) => i.id === id);
  const act = btn.dataset.act;
  if (act === 'play' || act === 'reveal') {
    const rec = S.library.find((r) => r.file === item.file);
    if (rec) bdl.invoke(act === 'play' ? 'library:open' : 'library:reveal', rec.id);
    else toast('That file is no longer in the library.', 'bad');
    return;
  }
  if (act === 'page') { bdl.invoke('library:openPage', item.pageUrl); showView('browse'); return; }
  bdl.invoke('queue:action', act, [id]);
});
$('#q-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.qrow.done');
  if (!row) return;
  const item = S.queue.find((i) => i.id === row.dataset.id);
  const rec = item && S.library.find((r) => r.file === item.file);
  if (rec) bdl.invoke('library:open', rec.id);
});
$('#q-pause-all').onclick = () => bdl.invoke('queue:action', 'pause');
$('#q-resume-all').onclick = () => bdl.invoke('queue:action', 'resume');
$('#q-stop-waiting').onclick = () => bdl.invoke('queue:action', 'stopWaiting');
$('#q-retry-all').onclick = () => bdl.invoke('queue:action', 'retry');
$('#q-clear').onclick = () => bdl.invoke('queue:action', 'clearFinished');
$('#st-stop').onclick = () => bdl.invoke('queue:action', 'stop');

function toggleAddLinks(open) {
  const f = $('#addlinks');
  f.hidden = open === undefined ? !f.hidden : !open;
  if (!f.hidden) $('#addlinks-text').focus();
}
$('#q-addlinks-toggle').onclick = () => toggleAddLinks();
$('#addlinks').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#addlinks-text').value;
  if (!/https?:\/\//.test(text)) { toast('Paste at least one link starting with http:// or https://', 'bad'); return; }
  const go = $('#addlinks-go');
  go.disabled = true;
  go.textContent = 'Looking up links…';
  try {
    const r = await bdl.invoke('queue:addLinks', text, { format: $('#addlinks-format').value, force: $('#addlinks-force').checked, root: saveInValue('#addlinks-dir') });
    const parts = [];
    if (r.added) parts.push(`Added ${r.added}`);
    if (r.already) parts.push(`${r.already} already in your library`);
    if (r.failed.length) parts.push(`no media found at ${r.failed.length} link${r.failed.length > 1 ? 's' : ''}`);
    toast(parts.join(', ') || 'Nothing new to add', r.failed.length && !r.added ? 'bad' : 'info');
    if (r.added) { $('#addlinks-text').value = ''; toggleAddLinks(false); }
  } finally {
    go.disabled = false;
    go.textContent = 'Add to queue';
  }
};

// ---------- library ----------

function libFiltered() {
  const { type, q, site, coll, sort } = S.lib;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let items = S.library.filter((r) =>
    (type === 'all' || r.media === type) &&
    (!site || r.site === site) &&
    (coll === null || (r.collection || '') === coll) &&
    words.every((w) => `${r.title} ${r.collection || ''} ${r.site}`.toLowerCase().includes(w)));
  const by = {
    new: (a, b) => b.addedAt - a.addedAt,
    old: (a, b) => a.addedAt - b.addedAt,
    name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    size: (a, b) => (b.size || 0) - (a.size || 0),
  }[sort];
  return items.sort(by);
}

function renderLibrary() {
  // Sidebar: every site, with its collections underneath.
  const sites = new Map();
  for (const r of S.library) {
    if (S.lib.type !== 'all' && r.media !== S.lib.type) continue;
    if (!sites.has(r.site)) sites.set(r.site, new Map());
    const colls = sites.get(r.site);
    colls.set(r.collection || '', (colls.get(r.collection || '') || 0) + 1);
  }
  const total = [...sites.values()].reduce((a, c) => a + [...c.values()].reduce((x, y) => x + y, 0), 0);
  let tree = `<button data-site="" ${!S.lib.site ? 'aria-current="true"' : ''}><span class="l">Everything</span><span class="n">${total}</span></button>`;
  for (const [site, colls] of [...sites].sort((a, b) => a[0].localeCompare(b[0]))) {
    const n = [...colls.values()].reduce((x, y) => x + y, 0);
    tree += `<button data-site="${esc(site)}" ${S.lib.site === site && S.lib.coll === null ? 'aria-current="true"' : ''}><span class="l">${esc(site)}</span><span class="n">${n}</span></button>`;
    if (S.lib.site === site) {
      tree += '<div class="sub">' + [...colls].sort((a, b) => a[0].localeCompare(b[0])).map(([c, k]) =>
        `<button data-site="${esc(site)}" data-coll="${esc(c)}" ${S.lib.coll === c ? 'aria-current="true"' : ''}><span class="l">${esc(c || 'Not in a folder')}</span><span class="n">${k}</span></button>`).join('') + '</div>';
    }
  }
  $('#lib-tree').innerHTML = tree;

  const items = libFiltered();
  const list = $('#lib-list');
  for (const id of [...S.lib.sel]) if (!S.library.some((r) => r.id === id)) S.lib.sel.delete(id);
  if (!S.library.length) {
    list.innerHTML = `<div class="empty"><h3>Nothing downloaded yet</h3><p>Everything you download is filed here by site and folder, ready to play, move or tidy up.</p></div>`;
  } else if (!items.length) {
    list.innerHTML = `<div class="empty"><h3>No matches</h3><p>Try a different search, or pick Everything on the left.</p></div>`;
  } else {
    const groups = new Map();
    for (const r of items) {
      const k = `${r.site}\u0000${r.collection || ''}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    let html = '';
    const missing = items.filter((r) => r.missing).length;
    if (missing) html += `<div class="summary missing-note">${missing} file${missing > 1 ? 's were' : ' was'} moved or deleted outside browseDL.&nbsp;<button class="btn quiet small" id="lib-forget">Remove ${missing > 1 ? 'them' : 'it'} from the library</button></div>`;
    for (const [k, rows] of groups) {
      const [site, coll] = k.split('\u0000');
      html += `<div class="coll"><h3>${esc(coll || 'Not in a folder')}<span class="site">${esc(site)}</span></h3>${rows.map(libRowHtml).join('')}</div>`;
    }
    list.innerHTML = html;
    for (const img of $$('img', list)) img.onerror = () => { img.parentElement.innerHTML = icon('video'); };
  }
  const n = S.lib.sel.size;
  $('#lib-selbar').hidden = !n;
  $('#lib-selcount').textContent = `${n} selected`;
}

function libRowHtml(r) {
  const thumb = r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy">` : icon(r.media === 'audio' ? 'audio' : 'video');
  const ext = (r.file.split('.').pop() || '').toUpperCase();
  const b = (act, ic, title) => `<button class="btn quiet icon" data-act="${act}" title="${title}">${icon(ic)}</button>`;
  return `<div class="lrow${S.lib.sel.has(r.id) ? ' sel' : ''}${r.missing ? ' missing' : ''}" data-id="${r.id}">
    <input type="checkbox" ${S.lib.sel.has(r.id) ? 'checked' : ''} aria-label="Select">
    <div class="thumb" data-act="play" title="Play">${thumb}</div>
    <div class="main"><div class="title" title="${esc(r.file)}">${esc(r.title)}</div>
      <div class="sub">${r.missing ? 'File missing' : esc([r.album, ext, fmtDur(r.duration), fmtSize(r.size)].filter(Boolean).join('  '))}</div></div>
    <div class="info">${fmtWhen(r.addedAt)}</div>
    <div class="acts">${b('play', 'play', 'Play')}${b('reveal', 'folder', 'Show in folder')}${r.pageUrl ? b('page', 'link', 'Open the page it came from') : ''}${b('rename', 'pencil', 'Rename')}${b('move', 'move', 'Move to folder')}</div>
  </div>`;
}

$('#lib-tree').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.lib.site = b.dataset.site || null;
  S.lib.coll = b.dataset.coll !== undefined ? b.dataset.coll : null;
  renderLibrary();
});
$('#lib-search').addEventListener('input', (e) => { S.lib.q = e.target.value; renderLibrary(); });
$('#lib-sort').onchange = (e) => { S.lib.sort = e.target.value; renderLibrary(); };
for (const b of $$('.chips button')) {
  b.onclick = () => {
    S.lib.type = b.dataset.type;
    for (const x of $$('.chips button')) x.setAttribute('aria-pressed', String(x === b));
    renderLibrary();
  };
}
$('#lib-folder').onclick = () => bdl.invoke('app:openFolder');
$('#lib-list').addEventListener('change', (e) => {
  const row = e.target.closest('.lrow');
  if (!row || e.target.type !== 'checkbox') return;
  if (e.target.checked) S.lib.sel.add(row.dataset.id);
  else S.lib.sel.delete(row.dataset.id);
  renderLibrary();
});
$('#lib-list').addEventListener('click', async (e) => {
  if (e.target.closest('#lib-forget')) {
    const n = await bdl.invoke('library:forgetMissing');
    toast(`Removed ${n} missing file${n === 1 ? '' : 's'} from the library`);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.lrow');
  const r = S.library.find((x) => x.id === row.dataset.id);
  if (!r) return;
  switch (btn.dataset.act) {
    case 'play': bdl.invoke('library:open', r.id); break;
    case 'reveal': bdl.invoke('library:reveal', r.id); break;
    case 'page': bdl.invoke('library:openPage', r.pageUrl); showView('browse'); break;
    case 'rename': {
      const title = await ask({ title: 'Rename', value: r.title, ok: 'Rename' });
      if (title && title.trim() && title !== r.title) await bdl.invoke('library:rename', r.id, title.trim());
      break;
    }
    case 'move': moveItems([r.id]); break;
    default:
  }
});
$('#lib-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.lrow');
  if (row && !e.target.closest('button, input')) bdl.invoke('library:open', row.dataset.id);
});

async function moveItems(ids) {
  const colls = [...new Set(S.library.map((r) => r.collection).filter(Boolean))].sort();
  const first = S.library.find((r) => r.id === ids[0]);
  const coll = await ask({
    title: ids.length > 1 ? `Move ${ids.length} files to a folder` : 'Move to a folder',
    text: 'Type a folder name, or pick one you already have. Leave it empty to take them out of any folder.',
    value: first && first.collection || '',
    options: colls,
    ok: 'Move',
    allowEmpty: true,
  });
  if (coll === null) return;
  const r = await bdl.invoke('library:move', ids, coll.trim());
  if (r.errors.length) toast(`Couldn't move some files: ${r.errors[0]}`, 'bad');
  else toast(r.moved ? `Moved ${r.moved} file${r.moved === 1 ? '' : 's'}` : 'Updated');
}
$('#lib-sel-move').onclick = () => moveItems([...S.lib.sel]);
$('#lib-sel-none').onclick = () => { S.lib.sel.clear(); renderLibrary(); };
$('#lib-sel-forget').onclick = async () => {
  const ids = [...S.lib.sel];
  if (!(await confirmBox({ title: `Remove ${ids.length} from the library?`, text: 'The files stay on your computer. browseDL just stops listing them, and may download them again.', ok: 'Remove' }))) return;
  await bdl.invoke('library:remove', ids, false);
  S.lib.sel.clear();
};
$('#lib-sel-trash').onclick = async () => {
  const ids = [...S.lib.sel];
  if (!(await confirmBox({ title: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}?`, text: 'They go to your computer\'s bin, so you can still get them back from there.', ok: 'Delete' }))) return;
  const r = await bdl.invoke('library:remove', ids, true);
  S.lib.sel.clear();
  toast(r.failed.length ? `Couldn't delete ${r.failed.length} file(s)` : `Deleted ${r.removed}`, r.failed.length ? 'bad' : 'info');
};

// ---------- dialogs ----------

function ask({ title, text = '', value = '', options = [], ok = 'OK', allowEmpty = false, input = true }) {
  const dlg = $('#dlg');
  $('#dlg-title').textContent = title;
  $('#dlg-text').textContent = text;
  $('#dlg-text').hidden = !text;
  const inp = $('#dlg-input');
  inp.hidden = !input;
  inp.value = value;
  inp.required = input && !allowEmpty;
  $('#dlg-options').innerHTML = options.map((o) => `<option value="${esc(o)}">`).join('');
  $('#dlg-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  if (input) { inp.focus(); inp.select(); }
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? (input ? inp.value : true) : null), { once: true });
  });
}
async function confirmBox(o) {
  return (await ask({ ...o, input: false })) === true;
}

// ---------- settings ----------

function renderSettings() {
  const s = S.settings;
  $('#s-dir').textContent = s.downloadDir;
  $('#s-dir').title = s.downloadDir;
  $('#s-layout').innerHTML = optionList(S.layouts, s.layout);
  $('#s-split').checked = !!s.splitByType;
  $('#s-format').innerHTML = optionList(S.formats, s.format);
  $('#s-concurrency').value = String(s.concurrency);
  $('#s-skip').checked = !!s.skipDownloaded;
  $('#s-autoscan').checked = !!s.autoScan;
  $('#s-minsize').value = s.minSizeKB;
  const browsers = { browsedl: 'browseDL\'s own browser', ...Object.fromEntries(S.browsers.map((b) => [b, `${b[0].toUpperCase()}${b.slice(1)}`])) };
  $('#s-login').innerHTML = optionList(browsers, s.loginSource);
  if (document.activeElement !== $('#s-home')) $('#s-home').value = s.homePage;
  const sep = S.platform === 'win32' ? '\\' : '/';
  const parts = [s.downloadDir];
  if (s.splitByType) parts.push('Video');
  if (s.layout === 'site-collection') parts.push('youtube.com', 'Some playlist');
  else if (s.layout === 'site') parts.push('youtube.com');
  else if (s.layout === 'collection') parts.push('Some playlist');
  parts.push('A video [id].mp4');
  $('#s-preview').textContent = parts.join(sep);
  renderSaveIn('#catch-dir');
  renderSaveIn('#addlinks-dir');
  for (const sel of ['#catch-format', '#addlinks-format']) {
    const el = $(sel);
    const cur = el.value || s.format;
    el.innerHTML = optionList(S.formats, cur);
  }
}
const setSetting = (patch) => bdl.invoke('settings:set', patch);
$('#s-dir-pick').onclick = () => bdl.invoke('settings:chooseFolder');
$('#s-layout').onchange = (e) => setSetting({ layout: e.target.value });
$('#s-split').onchange = (e) => setSetting({ splitByType: e.target.checked });
$('#s-format').onchange = (e) => {
  setSetting({ format: e.target.value });
  $('#catch-format').value = e.target.value;
  $('#addlinks-format').value = e.target.value;
};
$('#s-concurrency').onchange = (e) => setSetting({ concurrency: Number(e.target.value) });
$('#s-skip').onchange = (e) => setSetting({ skipDownloaded: e.target.checked });
$('#s-autoscan').onchange = (e) => setSetting({ autoScan: e.target.checked });
$('#s-minsize').onchange = (e) => setSetting({ minSizeKB: Math.max(0, Number(e.target.value) || 0) });
$('#s-login').onchange = (e) => setSetting({ loginSource: e.target.value });
$('#s-home').onchange = (e) => setSetting({ homePage: e.target.value.trim() || 'https://duckduckgo.com/' });
$('#s-clear').onclick = async () => { if (await bdl.invoke('app:clearBrowsing')) toast('Logged out of everything'); };
$('#s-update').onclick = async () => {
  const b = $('#s-update');
  b.disabled = true;
  b.textContent = 'Updating…';
  const r = await bdl.invoke('app:updateYtdlp');
  b.disabled = false;
  b.textContent = 'Update yt-dlp';
  toast(r.ok ? (r.output.split('\n').pop() || 'yt-dlp is up to date') : `Update failed: ${r.output}`, r.ok ? 'info' : 'bad');
  loadVersions();
};
async function loadVersions() {
  const v = await bdl.invoke('versions');
  $('#s-ytdlp').textContent = v.ytdlp ? `Version ${v.ytdlp}` : 'Not found';
}

// ---------- wiring ----------

for (const b of $$('.nav')) b.onclick = () => showView(b.dataset.view);

bdl.on('tabs', (t) => { S.tabs = t; renderTabs(); });
bdl.on('media', (m) => {
  if (!m || m.tabId !== S.tabs.activeId) return;
  S.media = m;
  renderCatch();
});
bdl.on('queue', (q) => { S.queue = q; if (S.view === 'queue') renderQueue(); renderStatus(); });
bdl.on('queue:items', patchQueue);
bdl.on('library', (l) => { S.library = l; if (S.view === 'library') renderLibrary(); });
bdl.on('settings', (s) => { S.settings = s; renderSettings(); });
bdl.on('toast', (t) => toast(t.message, t.kind));
bdl.on('focus-address', () => { showView('browse'); $('#address').focus(); });
bdl.on('show-view', (v) => showView(v));
bdl.on('open-catch', () => { showView('browse'); setCatchOpen(true); });

new ResizeObserver(() => reportBounds()).observe($('#viewport'));
window.addEventListener('resize', reportBounds);

(async function init() {
  const st = await bdl.invoke('state');
  Object.assign(S, {
    settings: st.settings, formats: st.formats, layouts: st.layouts, browsers: st.browsers, platform: st.platform,
    tabs: st.tabs, media: st.media, queue: st.queue, library: st.library,
  });
  $('#s-version').textContent = st.version;
  renderSettings();
  $('#catch-format').value = S.settings.format;
  $('#addlinks-format').value = S.settings.format;
  $('#catch').hidden = !S.settings.catchOpen;
  $('#catch-toggle').setAttribute('aria-pressed', String(!!S.settings.catchOpen));
  renderTabs();
  renderCatch();
  renderStatus();
  showView(S.settings.lastView === 'settings' ? 'browse' : S.settings.lastView || 'browse');
})();
