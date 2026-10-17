'use strict';
// The download queue: runs yt-dlp for each item, a few at a time, and files the results.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Y = require('./ytdlp');
const { outputDir, safeName, siteName, templateLiteral } = require('./paths');
const { mediaKey, AUDIO_EXT, extOf } = require('./detect');
const { writeCookieFile } = require('./cookies');

const ACTIVE = new Set(['queued', 'running', 'paused']);
const PERSIST = [
  'id', 'url', 'title', 'kind', 'media', 'pageUrl', 'site', 'collection', 'format', 'headers', 'name', 'thumbnail',
  'duration', 'keys', 'status', 'progress', 'size', 'file', 'error', 'addedAt', 'startedAt', 'finishedAt', 'extractor',
  'root', 'multi', 'playlistItem', 'files', 'part',
];

class Queue extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./store').JsonStore} deps.store  holds the queue items
   * @param {() => object} deps.settings
   * @param {import('./bins').Bins} deps.bins
   * @param {import('./library').Library} deps.library
   * @param {() => Promise<Electron.Cookie[]>} deps.getCookies
   * @param {() => string} deps.userAgent
   * @param {string} deps.workDir  where partial downloads and cookie files live
   * @param {(url:string) => Promise<{args:string[], file:string}|null>} [deps.authFor]  login token for sites that need one
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.items = (this.store.data || []).map((it) => ({ ...it }));
    this.procs = new Map(); // id -> {child, intent}
    this.reserved = new Map(); // id -> "folder/name" being written right now
    for (const it of this.items) {
      if (it.status === 'running') it.status = 'queued';
      it.speed = null;
      it.eta = null;
      it.phase = null;
    }
    fs.mkdirSync(this.workDir, { recursive: true });
    this._cleanOrphans();
  }

  // ---------- reading ----------

  list() {
    return this.items.map(publicItem);
  }

  get(id) {
    return this.items.find((i) => i.id === id);
  }

  counts() {
    const c = { queued: 0, running: 0, paused: 0, done: 0, failed: 0, stopped: 0 };
    for (const i of this.items) c[i.status] = (c[i.status] || 0) + 1;
    return c;
  }

  // ---------- adding ----------

  /**
   * @param {object[]} entries  {url, title, kind, media, pageUrl, collection, format, headers, name, thumbnail, duration, keys}
   * @param {{force?:boolean}} opts  force: download even if it's in the library already
   */
  add(entries, opts = {}) {
    const settings = this.settings();
    const added = [];
    let already = 0;
    let dupes = 0;
    for (const e of entries) {
      if (!e || !e.url) continue;
      const idKey = e.id && e.extractor ? `${String(e.extractor).toLowerCase()}:${e.id}` : null;
      // Works of one list share its URL, so each is told apart by its position.
      const urlKey = e.playlistItem ? `${mediaKey(e.url)}#${e.playlistItem}` : mediaKey(e.url);
      const keys = [...new Set([urlKey, idKey, ...(e.keys || [])].filter(Boolean))];
      if (this.items.some((i) => ACTIVE.has(i.status) && i.keys && i.keys.some((k) => keys.includes(k)))) {
        dupes++;
        continue;
      }
      if (!opts.force && settings.skipDownloaded && this.library.has(keys)) {
        already++;
        continue;
      }
      const item = {
        id: crypto.randomUUID(),
        url: e.url,
        title: e.title || e.name || e.url,
        kind: e.kind || 'page',
        media: e.media || 'unknown',
        pageUrl: e.pageUrl || (e.kind === 'page' ? e.url : null),
        site: e.site || siteName(e.pageUrl || e.url),
        collection: e.collection || null,
        format: e.format || settings.format || 'best',
        headers: e.headers || {},
        name: e.name || null,
        thumbnail: e.thumbnail || null,
        duration: e.duration || null,
        keys,
        root: e.root || null, // a download folder chosen for this batch, instead of the default
        multi: !!e.multi, // a link that may hold several works (a concert, a playlist)
        playlistItem: e.playlistItem || null,
        status: 'queued',
        progress: null,
        size: e.size || null,
        file: null,
        error: null,
        addedAt: Date.now(),
      };
      this.items.push(item);
      added.push(item);
    }
    if (added.length) this._changed(true);
    this.pump();
    return { added: added.length, already, dupes };
  }

  // ---------- actions ----------

  action(name, ids) {
    const pick = (pred) => this.items.filter((i) => (!ids || ids.includes(i.id)) && pred(i));
    switch (name) {
      case 'pause':
        for (const i of pick((i) => i.status === 'queued' || i.status === 'running')) this._halt(i, 'paused');
        break;
      case 'resume':
        for (const i of pick((i) => i.status === 'paused')) i.status = 'queued';
        break;
      case 'stop':
        for (const i of pick((i) => ACTIVE.has(i.status))) this._halt(i, 'stopped', true);
        break;
      case 'stopWaiting':
        for (const i of pick((i) => i.status === 'queued' || i.status === 'paused')) this._halt(i, 'stopped', true);
        break;
      case 'retry':
        for (const i of pick((i) => i.status === 'failed' || i.status === 'stopped')) {
          Object.assign(i, { status: 'queued', error: null, progress: null, phase: null });
        }
        break;
      case 'remove':
        for (const i of pick(() => true)) {
          if (ACTIVE.has(i.status)) this._halt(i, 'stopped', true);
          else this._cleanTemp(i);
        }
        this.items = this.items.filter((i) => ids ? !ids.includes(i.id) : false);
        break;
      case 'clearFinished':
        this.items = this.items.filter((i) => i.status !== 'done' || (ids && !ids.includes(i.id)));
        break;
      case 'top':
      case 'bottom': {
        const moving = pick((i) => i.status === 'queued' || i.status === 'paused');
        const rest = this.items.filter((i) => !moving.includes(i));
        this.items = name === 'top' ? [...moving, ...rest] : [...rest, ...moving];
        break;
      }
      default:
        throw new Error(`Unknown queue action ${name}`);
    }
    this._changed(true);
    this.pump();
  }

  /** Stop everything for app exit; running items start again next time. */
  shutdown() {
    for (const [id, p] of this.procs) {
      p.intent = 'queued';
      Y.killTree(p.child);
      const it = this.get(id);
      if (it) it.status = 'queued';
    }
    this._persist(true);
  }

  // ---------- running ----------

  pump() {
    const max = Math.max(1, Math.min(6, Number(this.settings().concurrency) || 2));
    while (this.procs.size < max) {
      const next = this.items.find((i) => i.status === 'queued' && !this.procs.has(i.id));
      if (!next) break;
      this._start(next).catch((err) => this._fail(next, err.message || String(err)));
    }
  }

  async _start(item) {
    const settings = this.settings();
    const slot = { child: null, intent: null };
    this.procs.set(item.id, slot);
    Object.assign(item, { status: 'running', error: null, phase: 'Starting', startedAt: Date.now(), speed: null, eta: null, part: null });
    this._changed(true);

    const audio = Y.FORMATS[item.format] && Y.FORMATS[item.format].audio;
    const media = audio ? 'audio' : item.media === 'audio' ? 'audio' : 'video';
    const root = item.root || settings.downloadDir;
    const homeDir = outputDir({
      root, layout: settings.layout, splitByType: settings.splitByType,
      media, site: item.site, collection: item.collection,
    });
    const tempDir = this._tempDir(item);
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const isDirect = item.kind !== 'page';
    let outName;
    let directBase = null;
    if (isDirect) {
      const base = safeName(item.name || item.title, 'Download', 150);
      const taken = new Set([...this.reserved.values()]);
      const unique = uniqueBase(homeDir, base, item, taken);
      this.reserved.set(item.id, path.join(homeDir, unique).toLowerCase());
      directBase = unique;
      outName = templateLiteral(unique);
    } else {
      outName = item.multi ? Y.MULTI_OUTNAME : '%(title).150B [%(id)s]';
    }

    let cookieFile = null;
    let cookiesFromBrowser = null;
    if (settings.loginSource && settings.loginSource !== 'browsedl') {
      cookiesFromBrowser = settings.loginSource;
    } else {
      cookieFile = path.join(this.workDir, `cookies-${item.id}.txt`);
      writeCookieFile(cookieFile, await this.getCookies());
    }

    const auth = this.authFor && !isDirect ? await this.authFor(item.url).catch(() => null) : null;
    const bin = await this.bins.ytdlp();
    if (slot.intent) {
      // Stopped while we were getting ready.
      if (cookieFile) rm(cookieFile);
      if (auth) rm(auth.file);
      this.procs.delete(item.id);
      this.reserved.delete(item.id);
      this.pump();
      return;
    }
    // yt-dlp also writes the saved file's path here, always as UTF-8, because on Windows the
    // path it prints can come back garbled when titles have accents or curly quotes.
    const pathFile = path.join(this.workDir, `saved-${item.id}.txt`);
    rm(pathFile);
    const args = Y.downloadArgs({
      url: item.url, format: item.format, homeDir, tempDir, outName, cookieFile, cookiesFromBrowser,
      userAgent: this.userAgent(), headers: item.headers, ffmpegDir: this.bins.ffmpegDir, isDirect, pathFile,
      multi: item.multi, playlistItem: item.playlistItem, authArgs: auth ? auth.args : null,
    });

    const tracker = new Y.ProgressTracker();
    let file = null;
    let videoId = null;
    let part = null; // which work of a list is downloading
    let tracker2 = tracker;
    let lastError = null;
    const errors = [];
    const onLine = (line) => {
      const ev = Y.parseLine(line);
      if (!ev) return;
      if (ev.type === 'meta') {
        const m = ev.meta || {};
        if (item.multi && m.playlist_index && m.playlist_index !== (part && part.index)) {
          part = { index: m.playlist_index, count: m.n_entries || null };
          tracker2 = new Y.ProgressTracker();
          item.part = part;
        }
        tracker2.setFormat(m.format_id);
        if (m.title && !isDirect && !item.multi) item.title = m.title;
        if (item.multi && m.playlist_title && item.title === item.url) item.title = m.playlist_title;
        if (m.thumbnail && !item.thumbnail) item.thumbnail = m.thumbnail;
        if (m.duration) item.duration = m.duration;
        if (m.extractor_key) item.extractor = m.extractor_key;
        if (m.id) videoId = String(m.id);
        if (m.id && m.extractor_key && !isDirect) {
          const k = `${String(m.extractor_key).toLowerCase()}:${m.id}`;
          if (!item.keys.includes(k)) item.keys.push(k);
        }
        item.phase = 'Downloading';
        this._changed(false, item.id);
      } else if (ev.type === 'progress') {
        let p = tracker2.update(ev);
        if (p != null && part && part.count) p = (part.index - 1 + p) / part.count;
        if (p != null) item.progress = p;
        item.speed = ev.speed;
        item.eta = part && part.count > 1 ? null : ev.eta;
        if (ev.total && !part) item.size = tracker2.parts > 1 ? item.size : ev.total;
        item.phase = tracker2.parts > 1 ? (tracker2.index === 0 ? 'Downloading picture' : 'Downloading sound') : 'Downloading';
        if (part && part.count > 1) item.phase = `Work ${part.index} of ${part.count}: ${item.phase.toLowerCase()}`;
        this._changed(false, item.id);
      } else if (ev.type === 'pp' && ev.status === 'started') {
        const names = { Merger: 'Joining picture and sound', ExtractAudio: 'Converting audio', FFmpegExtractAudio: 'Converting audio', EmbedThumbnail: 'Adding cover art', FixupM3u8: 'Tidying up', Metadata: 'Adding details', FFmpegMetadata: 'Adding details', MoveFiles: 'Filing' };
        item.phase = names[ev.postprocessor] || 'Finishing';
        item.speed = null;
        item.eta = null;
        this._changed(false, item.id);
      } else if (ev.type === 'file') {
        file = ev.path;
      } else if (ev.type === 'error') {
        lastError = ev.message;
        errors.push(ev.message);
      }
    };
    const { child, done } = Y.run(bin, args, {
      env: this.bins.env(),
      onLine,
      onErrLine: onLine,
      cwd: tempDir,
    });
    slot.child = child;
    const result = await done;
    if (cookieFile) rm(cookieFile);
    if (auth) rm(auth.file);
    this.procs.delete(item.id);
    this.reserved.delete(item.id);
    let saved = [];
    if (!slot.intent && result.code === 0) {
      saved = item.multi ? savedFiles(pathFile) : [];
      if (!saved.length) {
        const f = locateSaved({ pathFile, printed: file, homeDir, startedAt: item.startedAt, videoId: isDirect ? null : videoId, base: directBase });
        if (f) saved = [{ filepath: f }];
      }
    }
    file = saved.length ? saved[0].filepath : null;
    rm(pathFile);

    if (slot.intent) {
      // Paused, stopped or app closing: _halt already set the status.
      if (slot.intent === 'stopped') this._cleanTemp(item);
    } else if (result.code === 0 && file) {
      this._cleanTemp(item);
      let total = 0;
      let finalMedia = 'video';
      for (const f of saved) {
        let size = null;
        try { size = fs.statSync(f.filepath).size; total += size; } catch { /* ignore */ }
        finalMedia = audio || AUDIO_EXT.has(extOf('file:///' + path.basename(f.filepath))) ? 'audio' : 'video';
        const own = f.id && f.extractor_key ? [`${String(f.extractor_key).toLowerCase()}:${f.id}`] : [];
        this.library.add({
          title: item.multi ? f.title || path.basename(f.filepath) : item.title, file: f.filepath,
          site: item.site, collection: item.collection, media: finalMedia, size,
          duration: (item.multi ? f.duration : item.duration) || f.duration || null,
          thumbnail: (item.multi ? f.thumbnail : item.thumbnail) || f.thumbnail || null,
          sourceUrl: item.url, pageUrl: item.pageUrl, keys: [...item.keys, ...own], format: item.format, root,
          album: item.multi && saved.length > 1 ? item.title : null,
        });
      }
      Object.assign(item, {
        status: 'done', progress: 1, file, files: saved.map((f) => f.filepath), size: total || null,
        phase: null, speed: null, eta: null, part: null, finishedAt: Date.now(), media: finalMedia,
      });
      this.emit('finished', item);
    } else if (result.error) {
      this._fail(item, `Couldn't start the downloader: ${result.error.message}`);
    } else if (result.code === 0 && !file) {
      this._fail(item, lastError ? Y.friendlyError(lastError) : `The download finished, but browseDL couldn't find the saved file. Check ${homeDir}`);
    } else {
      this._fail(item, Y.friendlyError(lastError || errors.join(' ') || `The downloader stopped (code ${result.code}).`));
    }
    this._changed(true);
    this.pump();
  }

  _fail(item, message) {
    this.procs.delete(item.id);
    this.reserved.delete(item.id);
    Object.assign(item, { status: 'failed', error: message, phase: null, speed: null, eta: null, finishedAt: Date.now() });
    this._changed(true);
    this.emit('failed', item);
  }

  _halt(item, status, cleanup = false) {
    const p = this.procs.get(item.id);
    item.status = status;
    item.phase = null;
    item.speed = null;
    item.eta = null;
    if (p) {
      p.intent = status;
      Y.killTree(p.child);
    } else if (cleanup) {
      this._cleanTemp(item);
    }
    if (cleanup) item.progress = null;
  }

  _tempDir(item) {
    return path.join(this.workDir, 'parts', item.id);
  }

  _cleanTemp(item) {
    rmrf(this._tempDir(item));
  }

  /** Partial downloads whose queue item no longer exists. */
  _cleanOrphans() {
    const parts = path.join(this.workDir, 'parts');
    try {
      const ids = new Set(this.items.map((i) => i.id));
      for (const d of fs.readdirSync(parts)) if (!ids.has(d)) rmrf(path.join(parts, d));
    } catch { /* none yet */ }
    try {
      for (const f of fs.readdirSync(this.workDir)) if (/^cookies-.*\.txt$/.test(f)) rm(path.join(this.workDir, f));
    } catch { /* ignore */ }
  }

  // ---------- change tracking ----------

  _changed(structural, id) {
    if (structural) this._structural = true;
    if (id) (this._dirty || (this._dirty = new Set())).add(id);
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      const structuralNow = this._structural;
      const dirty = this._dirty ? [...this._dirty] : [];
      this._structural = false;
      this._dirty = null;
      if (structuralNow) this.emit('list', this.list());
      else this.emit('items', dirty.map((d) => this.get(d)).filter(Boolean).map(publicItem));
      this._persist(false);
    }, 200);
  }

  _persist(now) {
    this.store.data = this.items.map((i) => {
      const o = {};
      for (const k of PERSIST) if (i[k] !== undefined) o[k] = i[k];
      return o;
    });
    if (now) this.store.saveNow();
    else this.store.save();
  }
}

/**
 * Find the file yt-dlp just saved: from the UTF-8 path file, then the printed path, then by
 * looking in the folder for the video's [id] or the chosen name, or a file that just appeared.
 */
function locateSaved({ pathFile, printed, homeDir, startedAt, videoId, base }) {
  const exists = (f) => { try { return !!f && fs.statSync(f).isFile(); } catch { return false; } };
  const fromFile = savedFiles(pathFile);
  if (fromFile.length) return fromFile[fromFile.length - 1].filepath;
  if (exists(printed)) return printed;
  let names = [];
  try { names = fs.readdirSync(homeDir); } catch { return null; }
  const files = names
    .filter((n) => !n.startsWith('.') && !/\.(part|ytdl|temp|tmp)$/i.test(n) && !/\.part-Frag\d+/i.test(n))
    .map((n) => {
      const full = path.join(homeDir, n);
      try { const st = fs.statSync(full); return st.isFile() ? { n, full, t: st.mtimeMs } : null; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t);
  const noExt = (n) => n.replace(/\.[^.]+$/, '');
  if (videoId) {
    const hit = files.find((f) => noExt(f.n).endsWith(`[${videoId}]`));
    if (hit) return hit.full;
  }
  if (base) {
    const hit = files.find((f) => noExt(f.n).normalize('NFC').toLowerCase() === base.normalize('NFC').toLowerCase());
    if (hit) return hit.full;
  }
  const fresh = files.filter((f) => f.t >= (startedAt || 0) - 2000);
  return fresh.length === 1 ? fresh[0].full : null;
}

/** Files yt-dlp reported saving (one JSON object, or a bare path, per line) that really exist. */
function savedFiles(pathFile) {
  let lines;
  try { lines = fs.readFileSync(pathFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    let rec;
    try { rec = l.startsWith('{') ? JSON.parse(l) : { filepath: l }; } catch { continue; }
    if (!rec || !rec.filepath || seen.has(rec.filepath)) continue;
    try { if (!fs.statSync(rec.filepath).isFile()) continue; } catch { continue; }
    seen.add(rec.filepath);
    out.push(rec);
  }
  return out;
}

function publicItem(i) {
  const { headers, keys, ...rest } = i;
  return rest;
}

/** Avoid saving over a different file that already has this name. */
function uniqueBase(dir, base, item, reserved = new Set()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* new folder */ }
  const taken = new Set(names.map((n) => n.replace(/\.[^.]+$/, '').toLowerCase()));
  for (const r of reserved) if (path.dirname(r) === dir.toLowerCase()) taken.add(path.basename(r));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const b = `${base} (${n})`;
    if (!taken.has(b.toLowerCase())) return b;
  }
  return `${base} ${item.id.slice(0, 8)}`;
}

function rm(f) {
  try { fs.unlinkSync(f); } catch { /* gone */ }
}

function rmrf(d) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
}

module.exports = { Queue, uniqueBase, locateSaved, savedFiles };
