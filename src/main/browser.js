'use strict';
// The built-in browser: tabs that keep their logins, and catching media as pages load.
const { WebContentsView, BrowserWindow, session, Menu, clipboard, shell } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const D = require('./detect');
const { siteName } = require('./paths');
const SA = require('./siteauth');

const PARTITION = 'persist:browse';
const HOME = 'https://duckduckgo.com/';

class Browser extends EventEmitter {
  /**
   * @param {object} o
   * @param {Electron.BrowserWindow} o.win
   * @param {() => object} o.settings
   * @param {(url:string) => Promise<object>} o.scanPage  yt-dlp page scan
   * @param {(urls:string[], pageUrl:string) => {cancel:Function, result:Promise<object>}} o.checkLinks  which links yt-dlp knows
   */
  constructor(o) {
    super();
    this.win = o.win;
    this.settings = o.settings;
    this.scanPage = o.scanPage;
    this.checkLinks = o.checkLinks;
    this.patternOk = new Map(); // "host pattern" -> whether yt-dlp recognised that kind of link
    this.tokenLocks = new Map();
    this.tabs = [];
    this.activeId = null;
    this.bounds = null;
    this.visible = false;
    this.nextId = 1;
    this.byContents = new Map(); // webContents.id -> tab
    this.requestHeaders = new Map(); // request id -> {referer, origin}
    this.fullscreen = false;

    this.ses = session.fromPartition(PARTITION);
    this.userAgent = cleanUserAgent(this.ses.getUserAgent());
    this.ses.setUserAgent(this.userAgent);
    this._wireSession();
  }

  // ---------- session-wide hooks ----------

  _wireSession() {
    const ses = this.ses;
    ses.setPermissionRequestHandler((wc, permission, cb) => {
      cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'speaker-selection', 'storage-access', 'top-level-storage-access'].includes(permission));
    });

    ses.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
      if (!this.byContents.has(d.webContentsId)) return;
      const h = D.lowerHeaders(d.requestHeaders);
      if (h.referer || h.origin) {
        this.requestHeaders.set(d.id, { referer: h.referer, origin: h.origin });
        if (this.requestHeaders.size > 5000) this.requestHeaders.delete(this.requestHeaders.keys().next().value);
      }
    });

    ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
      const sent = this.requestHeaders.get(d.id);
      this.requestHeaders.delete(d.id);
      const tab = this.byContents.get(d.webContentsId);
      if (!tab || d.resourceType === 'mainFrame') return;
      const h = D.lowerHeaders(d.responseHeaders);
      const c = D.classifyResponse({ url: d.url, mime: h['content-type'], status: d.statusCode });
      if (!c) return;
      this._catch(tab, {
        url: d.url,
        ...c,
        mime: (h['content-type'] || '').split(';')[0] || null,
        size: D.sizeFromHeaders(d.responseHeaders, d.statusCode),
        source: 'network',
        headers: headerSet(sent, tab),
      });
    });

    ses.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (d) => this.requestHeaders.delete(d.id));

    // Files the page tries to download: media goes to the queue, anything else is saved straight away.
    ses.on('will-download', (event, dl, wc) => {
      const url = dl.getURL();
      const tab = this.byContents.get(wc && wc.id) || this.active();
      const c = D.classifyLink(url) || (/^(audio|video)\//.test(dl.getMimeType()) ? { kind: 'file', media: dl.getMimeType().startsWith('audio') ? 'audio' : 'video' } : null);
      if (c && /^https?:/.test(url)) {
        event.preventDefault();
        this.emit('download-request', {
          url, kind: c.kind, media: c.media, name: D.nameFromUrl(dl.getFilename() ? 'http://x/' + encodeURIComponent(dl.getFilename()) : url),
          pageUrl: tab ? tab.view.webContents.getURL() : url, headers: tab ? headerSet(null, tab) : {},
        });
        return;
      }
      const s = this.settings();
      const dir = path.join(s.downloadDir, siteName(tab ? tab.view.webContents.getURL() : url), 'Files');
      fs.mkdirSync(dir, { recursive: true });
      dl.setSavePath(uniquePath(path.join(dir, dl.getFilename() || 'download')));
      dl.once('done', (_e, state) => {
        if (state === 'completed') this.emit('file-saved', dl.getSavePath());
      });
    });
  }

  // ---------- tabs ----------

  newTab(url, { activate = true, opener = null } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab = {
      id: this.nextId++,
      view,
      media: new Map(),
      children: new Set(), // keys of HLS variants that belong to a master playlist we already listed
      scan: { status: 'idle' },
      scanUrl: null,
      pageLinks: [],
      linked: { status: 'idle' },
      scanTimer: null,
      domTimer: null,
      favicon: null,
      opener,
    };
    this.tabs.push(tab);
    this.byContents.set(view.webContents.id, tab);
    this._wireTab(tab);
    if (activate) this.activate(tab.id);
    view.webContents.loadURL(normaliseInput(url || this.settings().homePage || HOME)).catch(() => {});
    this._emitTabs();
    return tab;
  }

  _wireTab(tab) {
    const wc = tab.view.webContents;
    const update = () => this._emitTabs();
    wc.on('page-title-updated', update);
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', () => {
      update();
      this._scheduleDomScan(tab, 300);
      this._scheduleScan(tab, 600);
      // Many sites fill the page in after it "finishes" loading, so look again a little later.
      clearTimeout(tab.lateTimer);
      tab.lateTimer = setTimeout(() => this._scheduleDomScan(tab, 0), 3500);
    });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; update(); });
    wc.on('did-navigate', (_e, url) => {
      tab.media.clear();
      tab.children.clear();
      tab.scan = { status: 'idle' };
      tab.scanUrl = null;
      tab.pageLinks = [];
      tab.linked = { status: 'idle' };
      if (tab.linkAbort) tab.linkAbort();
      tab.favicon = null;
      this._emitMedia(tab);
      update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      update();
      this._scheduleDomScan(tab, 1200);
      this._scheduleScan(tab, 1500);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emit('toast', `Couldn't open ${shortUrl(url)}: ${desc}`);
      update();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') {
        // Login pop-ups (Google, Apple, Facebook…) need a real window that can talk back to the page.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, parent: this.win, modal: false },
        };
      }
      if (/^https?:/i.test(url)) this.newTab(url, { activate: disposition !== 'background-tab', opener: tab.id });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) this.newTab(url);
        return { action: 'deny' };
      });
    });
    wc.on('enter-html-full-screen', () => { this.fullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.fullscreen = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('context-menu', (_e, p) => this._contextMenu(tab, p));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (mod && input.key.toLowerCase() === 'l') { event.preventDefault(); this.emit('focus-address'); }
    });
    wc.on('render-process-gone', () => this.emit('toast', 'A page crashed. Reload it to try again.'));
  }

  active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  activate(id) {
    const tab = this.get(id);
    if (!tab) return;
    for (const t of this.tabs) {
      if (t !== tab && this.win.contentView.children.includes(t.view)) this.win.contentView.removeChildView(t.view);
    }
    this.activeId = id;
    this.layout();
    this._emitTabs();
    this._emitMedia(tab);
  }

  close(id) {
    const tab = this.get(id);
    if (!tab) return;
    const idx = this.tabs.indexOf(tab);
    if (this.win.contentView.children.includes(tab.view)) this.win.contentView.removeChildView(tab.view);
    this.byContents.delete(tab.view.webContents.id);
    clearTimeout(tab.scanTimer);
    clearTimeout(tab.domTimer);
    if (tab.scanAbort) tab.scanAbort();
    if (tab.linkAbort) tab.linkAbort();
    for (const t of ['linkTimer', 'lateTimer', 'mediaTimer']) clearTimeout(tab[t]);
    tab.view.webContents.close();
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs.find((t) => t.id === tab.opener) || this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) this.activate(next.id);
      else this.newTab();
    }
    this._emitTabs();
  }

  navigate(id, input) {
    const tab = this.get(id) || this.active();
    if (!tab) return;
    tab.view.webContents.loadURL(normaliseInput(input)).catch(() => {});
  }

  go(id, what) {
    const tab = this.get(id) || this.active();
    if (!tab) return;
    const wc = tab.view.webContents;
    const nav = wc.navigationHistory;
    if (what === 'back' && nav.canGoBack()) nav.goBack();
    if (what === 'forward' && nav.canGoForward()) nav.goForward();
    if (what === 'reload') wc.reload();
    if (what === 'stop') wc.stop();
    if (what === 'home') wc.loadURL(normaliseInput(this.settings().homePage || HOME)).catch(() => {});
  }

  /** The renderer tells us where the page area is; null hides the page (another screen is showing). */
  setBounds(rect) {
    this.bounds = rect;
    this.visible = !!rect;
    this.layout();
  }

  layout() {
    const tab = this.active();
    if (!tab) return;
    const cv = this.win.contentView;
    const show = this.fullscreen || this.visible;
    if (!show) {
      if (cv.children.includes(tab.view)) cv.removeChildView(tab.view);
      return;
    }
    if (!cv.children.includes(tab.view)) cv.addChildView(tab.view);
    if (this.fullscreen) {
      const [w, h] = this.win.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
    } else if (this.bounds) {
      const b = this.bounds;
      tab.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
    }
  }

  tabsState() {
    return {
      activeId: this.activeId,
      tabs: this.tabs.map((t) => {
        const wc = t.view.webContents;
        return {
          id: t.id,
          title: wc.getTitle() || shortUrl(wc.getURL()) || 'New tab',
          url: wc.getURL(),
          loading: wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          favicon: t.favicon,
          found: this._visibleMedia(t).length + (t.scan.entries ? t.scan.entries.length : 0),
        };
      }),
    };
  }

  _emitTabs() {
    clearTimeout(this._tabsTimer);
    this._tabsTimer = setTimeout(() => this.emit('tabs', this.tabsState()), 30);
  }

  // ---------- catching media ----------

  _catch(tab, m) {
    const key = D.mediaKey(m.url);
    const existing = tab.media.get(key);
    if (existing) {
      // Keep the freshest URL (signed links expire) and anything we didn't know before.
      existing.url = m.url;
      if (m.size && !existing.size) existing.size = m.size;
      for (const k of ['label', 'poster', 'duration']) if (m[k] && !existing[k]) existing[k] = m[k];
      if (m.headers && Object.keys(m.headers).length) existing.headers = { ...existing.headers, ...m.headers };
      if (existing.source !== 'network' && m.source === 'network') existing.seenPlaying = true;
      this._emitMedia(tab);
      return;
    }
    const item = {
      key,
      url: m.url,
      kind: m.kind,
      media: m.media,
      ext: m.ext || null,
      mime: m.mime || null,
      size: m.size || null,
      duration: m.duration || null,
      label: m.label || null,
      poster: m.poster || null,
      source: m.source,
      seenPlaying: m.source === 'network',
      headers: m.headers || {},
      drm: false,
      pageUrl: tab.view.webContents.getURL(),
      pageTitle: tab.view.webContents.getTitle(),
      at: Date.now(),
    };
    tab.media.set(key, item);
    if (item.kind === 'hls' || item.kind === 'dash') this._inspectManifest(tab, item);
    this._emitMedia(tab);
    this._emitTabs();
  }

  async _inspectManifest(tab, item) {
    try {
      const headers = {};
      if (item.headers.Referer) headers.Referer = item.headers.Referer;
      const res = await this.ses.fetch(item.url, { headers, bypassCustomProtocolHandlers: true });
      if (!res.ok) return;
      const text = (await res.text()).slice(0, 2_000_000);
      if (item.kind === 'hls') {
        const p = D.parseM3u8(text, item.url);
        item.drm = p.drm;
        if (p.duration) item.duration = p.duration;
        // A playlist of one quality only; hidden when its main playlist is listed too.
        if (!p.master) item.variant = true;
        if (p.master) {
          item.master = true;
          const heights = p.variants.map((v) => v.height).filter(Boolean);
          if (heights.length) item.height = Math.max(...heights);
          if (p.audioOnlyStream) item.media = 'audio';
          else if (heights.length) item.media = 'video';
          for (const v of [...p.variants.map((x) => x.url), ...p.audioRenditions]) tab.children.add(D.mediaKey(v));
        }
      } else {
        const p = D.parseMpd(text);
        item.drm = p.drm;
        if (p.duration) item.duration = p.duration;
        if (p.media !== 'unknown') item.media = p.media;
      }
      this._emitMedia(tab);
    } catch {
      /* the manifest couldn't be read; the item still works through yt-dlp */
    }
  }

  _visibleMedia(tab) {
    const minBytes = (Number(this.settings().minSizeKB) || 0) * 1024;
    const dir = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/[^/]*$/, ''); } catch { return u; } };
    const masterDirs = [...tab.media.values()].filter((m) => m.master).map((m) => dir(m.url));
    return [...tab.media.values()].filter((m) => {
      if (tab.children.has(m.key)) return false;
      if (m.variant && masterDirs.some((d) => dir(m.url).startsWith(d))) return false;
      if (m.kind === 'file' && m.size != null && m.size < minBytes) return false;
      return true;
    });
  }

  _scheduleDomScan(tab, delay) {
    clearTimeout(tab.domTimer);
    tab.domTimer = setTimeout(() => this.domScan(tab).catch(() => {}), delay);
  }

  async domScan(tab) {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const r = await wc.executeJavaScriptInIsolatedWorld(1999, [{ code: D.PAGE_SCAN_SCRIPT }]);
    if (!r) return;
    const headers = headerSet(null, tab);
    for (const e of r.elements || []) {
      const c = D.classifyLink(e.url) || { kind: 'file', media: e.tag === 'audio' ? 'audio' : 'video', ext: D.extOf(e.url) };
      this._catch(tab, { url: e.url, ...c, duration: e.duration, poster: e.poster, label: e.label, source: 'element', headers });
    }
    for (const l of r.links || []) {
      const c = D.classifyLink(l.url);
      if (c) this._catch(tab, { url: l.url, ...c, label: l.text, source: 'link', headers });
    }
    for (const m of r.meta || []) {
      const c = D.classifyLink(m.url);
      if (c) this._catch(tab, { url: m.url, ...c, source: 'element', headers });
    }
    tab.pageLinks = r.pages || [];
    this._scheduleLinkCheck(tab, 400);
  }

  _scheduleLinkCheck(tab, delay) {
    if (!this.settings().autoScan) return;
    clearTimeout(tab.linkTimer);
    tab.linkTimer = setTimeout(() => this.linkCheck(tab).catch(() => {}), delay);
  }

  /**
   * Find links on this page that lead to video pages: group the links by shape, ask yt-dlp about
   * one link from each group it hasn't seen before, and list every link in the groups it knows.
   */
  async linkCheck(tab, { force = false } = {}) {
    const url = tab.view.webContents.getURL();
    if (!/^https?:/i.test(url)) return;
    if (tab.scan.status === 'scanning') { this._scheduleLinkCheck(tab, 1500); return; }
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
    const groups = D.groupLinks(tab.pageLinks, url);
    const unknown = groups.filter((g) => force || !this.patternOk.has(`${host} ${g.pattern}`));
    if (unknown.length) {
      if (tab.linkAbort) tab.linkAbort();
      tab.linked = { ...tab.linked, status: 'checking', url };
      this._emitMedia(tab);
      let aborted = false;
      const job = this.checkLinks(unknown.map((g) => g.links[0].url), url);
      tab.linkAbort = () => { aborted = true; job.cancel(); };
      const res = await job.result;
      if (aborted || tab.view.webContents.isDestroyed() || tab.view.webContents.getURL() !== url) return;
      tab.linkAbort = null;
      if (res.ok) for (const g of unknown) this.patternOk.set(`${host} ${g.pattern}`, res.recognised.has(g.links[0].url));
    }
    const known = groups.filter((g) => this.patternOk.get(`${host} ${g.pattern}`));
    tab.linked = { status: 'done', url, groups: known };
    this._emitMedia(tab);
    this._emitTabs();
  }

  /**
   * A login token from a site's local storage in the built-in browser (for sites where yt-dlp
   * can't use cookies). Opens the site in a hidden window if no tab has it open, and lets the
   * site refresh an expired token.
   */
  async siteToken(site) {
    if (this.tokenLocks.has(site.id)) return this.tokenLocks.get(site.id);
    const p = this._readSiteToken(site).finally(() => this.tokenLocks.delete(site.id));
    this.tokenLocks.set(site.id, p);
    return p;
  }

  async _readSiteToken(site) {
    const read = async (wc) => {
      const code = `(${JSON.stringify(site.storageKeys)}).map((k) => { try { return localStorage.getItem(k); } catch { return null; } })`;
      const vals = await wc.executeJavaScriptInIsolatedWorld(1998, [{ code }]).catch(() => []);
      for (const v of vals || []) {
        const t = SA.cleanToken(v);
        if (t) return t;
      }
      return null;
    };
    const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
    const open = this.tabs.map((t) => t.view.webContents).find((wc) => !wc.isDestroyed() && originOf(wc.getURL()) === site.origin);
    if (open) {
      const t = await read(open);
      if (t && SA.tokenFresh(t)) return t;
    }
    // Load the site out of sight: first a tiny page to read storage, then the real site if the
    // token needs refreshing (the site's own code does that when it starts).
    const hidden = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true } });
    try {
      await hidden.webContents.loadURL(`${site.origin}/robots.txt`).catch(() => {});
      let t = await read(hidden.webContents);
      if (t && SA.tokenFresh(t)) return t;
      await hidden.webContents.loadURL(site.refreshUrl).catch(() => {});
      for (let i = 0; i < 20; i++) {
        t = await read(hidden.webContents);
        if (t && SA.tokenFresh(t)) return t;
        await new Promise((r) => setTimeout(r, 500));
      }
      return t;
    } finally {
      if (!hidden.isDestroyed()) hidden.destroy();
    }
  }

  _scheduleScan(tab, delay) {
    if (!this.settings().autoScan) return;
    clearTimeout(tab.scanTimer);
    tab.scanTimer = setTimeout(() => this.siteScan(tab), delay);
  }

  /** Ask yt-dlp whether it knows this site, and list the page's videos if it does. */
  async siteScan(tab, { force = false } = {}) {
    const url = tab.view.webContents.getURL();
    if (!/^https?:/i.test(url)) return;
    if (!force && tab.scanUrl === url && tab.scan.status !== 'error') return;
    if (tab.scanAbort) tab.scanAbort();
    tab.scanUrl = url;
    tab.scan = { status: 'scanning', url };
    this._emitMedia(tab);
    let aborted = false;
    const job = this.scanPage(url, { siteOnly: true });
    tab.scanAbort = () => { aborted = true; job.cancel(); };
    const res = await job.result;
    if (aborted || tab.scanUrl !== url) return;
    tab.scanAbort = null;
    if (res.ok && res.entries.length) tab.scan = { status: 'done', url, title: res.title, uploader: res.uploader, extractor: res.extractor, entries: res.entries };
    else if (res.ok || res.unsupported) tab.scan = { status: 'none', url };
    else tab.scan = { status: 'error', url, error: res.error };
    this._emitMedia(tab);
    this._emitTabs();
  }

  mediaState(tabId) {
    const tab = this.get(tabId) || this.active();
    if (!tab) return null;
    const wc = tab.view.webContents;
    return {
      tabId: tab.id,
      pageUrl: wc.getURL(),
      pageTitle: wc.getTitle(),
      site: siteName(wc.getURL()),
      scan: tab.scan,
      linked: tab.linked,
      media: this._visibleMedia(tab).sort((a, b) => rank(b) - rank(a) || a.at - b.at),
    };
  }

  _emitMedia(tab) {
    clearTimeout(tab.mediaTimer);
    tab.mediaTimer = setTimeout(() => this.emit('media', this.mediaState(tab.id)), 120);
  }

  // ---------- right-click menu ----------

  _contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    const mediaUrl = /^https?:/.test(p.srcURL || '') && (p.mediaType === 'video' || p.mediaType === 'audio') ? p.srcURL : null;
    if (mediaUrl) {
      items.push({
        label: `Download this ${p.mediaType}`,
        click: () => this.emit('download-request', {
          url: mediaUrl, kind: D.classifyLink(mediaUrl)?.kind || 'file', media: p.mediaType,
          pageUrl: wc.getURL(), headers: headerSet(null, tab), name: wc.getTitle(),
        }),
      });
    } else if (p.mediaType === 'video' || p.mediaType === 'audio') {
      items.push({ label: 'Download this page\'s media…', click: () => this.emit('open-catch') });
    }
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      const c = D.classifyLink(p.linkURL);
      items.push({
        label: c ? `Download linked ${c.media === 'audio' ? 'audio' : c.media === 'video' ? 'video' : 'stream'}` : 'Download from this link',
        click: () => this.emit('download-request', {
          url: p.linkURL, kind: c ? c.kind : 'page', media: c ? c.media : 'unknown', pageUrl: wc.getURL(),
          headers: c ? headerSet(null, tab) : {}, name: c ? (p.linkText || D.nameFromUrl(p.linkURL)) : null,
        }),
      });
      items.push({ label: 'Open link in new tab', click: () => this.newTab(p.linkURL, { activate: false, opener: tab.id }) });
      items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.selectionText) items.push({ role: 'copy' });
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Open page in your browser', click: () => shell.openExternal(wc.getURL()) },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  async clearData() {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    for (const t of this.tabs) t.view.webContents.reload();
  }

  cookies() {
    return this.ses.cookies.get({});
  }
}

// Media that was actually playing, then streams, then files, then links.
function rank(m) {
  let r = 0;
  if (m.seenPlaying) r += 4;
  if (m.kind === 'hls' || m.kind === 'dash') r += 2;
  if (m.source === 'element') r += 1;
  if (m.drm) r -= 10;
  return r;
}

function headerSet(sent, tab) {
  const h = {};
  const page = tab ? tab.view.webContents.getURL() : null;
  h.Referer = (sent && sent.referer) || page || undefined;
  if (sent && sent.origin) h.Origin = sent.origin;
  for (const k of Object.keys(h)) if (!h[k]) delete h[k];
  return h;
}

/** Look like the Chrome that Electron is built on, so sites don't refuse to log in. */
function cleanUserAgent(ua) {
  return String(ua).replace(/\s(browsedl|browseDL)\/\S+/gi, '').replace(/\sElectron\/\S+/i, '');
}

function normaliseInput(input) {
  const s = String(input || '').trim();
  if (!s) return HOME;
  if (/^(https?|file|about):/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) || /^localhost(:\d+)?(\/\S*)?$/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\S*)?$/.test(s)) {
    return (/^(localhost|\d)/.test(s) ? 'http://' : 'https://') + s;
  }
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function shortUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 1000; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return `${base} ${Date.now()}${ext}`;
}

module.exports = { Browser, PARTITION, normaliseInput, cleanUserAgent };
