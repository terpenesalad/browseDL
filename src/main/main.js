'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('./store');
const { Bins } = require('./bins');
const { Library } = require('./library');
const { Queue } = require('./queue');
const { Browser } = require('./browser');
const Y = require('./ytdlp');
const { LAYOUTS, siteName } = require('./paths');
const { mediaKey } = require('./detect');
const { writeCookieFile } = require('./cookies');
const SA = require('./siteauth');
const crypto = require('crypto');

const SELF_TEST = process.argv.includes('--self-test');
if (process.argv.includes('--version')) {
  try { require('fs').writeSync(1, `browseDL ${app.getVersion()}\n`); } catch { /* no console */ }
  process.exit(0);
}

app.setName('browseDL');
// Tests run with their own data folder so they never touch a real library.
if (process.env.BROWSEDL_USER_DATA) app.setPath('userData', process.env.BROWSEDL_USER_DATA);
if (!SELF_TEST && !app.requestSingleInstanceLock()) app.exit(0);

let win = null;
let browser = null;
let queue = null;
let library = null;
let settingsStore = null;
let bins = null;
const userDir = () => app.getPath('userData');

function defaults() {
  return {
    downloadDir: path.join(app.getPath('downloads'), 'browseDL'),
    concurrency: 2,
    format: 'best',
    layout: 'site-collection',
    splitByType: false,
    skipDownloaded: true,
    autoScan: true,
    minSizeKB: 150,
    loginSource: 'browsedl',
    homePage: 'https://duckduckgo.com/',
    lastView: 'browse',
    recentDirs: [],
    catchOpen: true,
  };
}
const settings = () => settingsStore.data;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function toast(message, kind = 'info') {
  send('toast', { message, kind });
}

/**
 * Login arguments for yt-dlp on sites that need a token rather than cookies (Digital Concert Hall),
 * read from the built-in browser. Returns null for every other site.
 */
async function authFor(url) {
  const site = SA.siteFor(url);
  if (!site || !browser) return null;
  const token = await browser.siteToken(site).catch(() => null);
  if (!token) return null;
  const file = path.join(userDir(), 'work', `netrc-${crypto.randomUUID()}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { args: SA.writeNetrc(file, site, token), file };
}

/**
 * Run yt-dlp with the built-in browser's logins. `build` gets the login options and returns the
 * arguments. Returns a cancel handle and a promise of {code, out, err}.
 */
function ytdlpJob({ authUrl, build, timeout = 120000 }) {
  let child = null;
  let cancelled = false;
  const temp = [];
  const cleanup = () => { for (const f of temp.splice(0)) { try { fs.unlinkSync(f); } catch { /* gone */ } } };
  const result = (async () => {
    const s = settings();
    let cookieFile = null;
    if (s.loginSource === 'browsedl') {
      cookieFile = path.join(userDir(), 'work', `cookies-scan-${crypto.randomUUID()}.txt`);
      fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
      writeCookieFile(cookieFile, await browser.cookies());
      temp.push(cookieFile);
    }
    const auth = authUrl ? await authFor(authUrl) : null;
    if (auth) temp.push(auth.file);
    const bin = await bins.ytdlp();
    if (cancelled) { cleanup(); return { cancelled: true }; }
    const args = build({
      cookieFile, cookiesFromBrowser: s.loginSource !== 'browsedl' ? s.loginSource : null,
      userAgent: browser.userAgent, authArgs: auth ? auth.args : [],
    });
    let out = '';
    let err = '';
    const run = Y.run(bin, args, { env: bins.env(), onLine: (l) => { out += l + '\n'; }, onErrLine: (l) => { err += l + '\n'; } });
    child = run.child;
    const timer = setTimeout(() => Y.killTree(child), timeout);
    const r = await run.done;
    clearTimeout(timer);
    cleanup();
    return { code: r.code, out, err, cancelled };
  })().catch((e) => { cleanup(); return { code: -1, out: '', err: `ERROR: ${e.message}` }; });
  return {
    cancel() {
      cancelled = true;
      if (child) Y.killTree(child);
      cleanup();
    },
    result,
  };
}

/** List what's on a page with yt-dlp. */
function scanPage(url, { siteOnly = false } = {}) {
  const job = ytdlpJob({ authUrl: url, build: (o) => Y.scanArgs({ url, siteOnly, ...o }) });
  return {
    cancel: job.cancel,
    result: job.result.then((r) => {
      if (r.cancelled) return { ok: false, cancelled: true };
      const errMsg = (r.err.match(/ERROR: (.*)/) || [])[1] || '';
      if (r.code !== 0) {
        return { ok: false, unsupported: /unsupported url|no suitable extractor/i.test(r.err), error: Y.friendlyError(errMsg || r.err.trim().split('\n').pop()) };
      }
      try {
        const json = JSON.parse(r.out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || 'null');
        return { ok: true, ...Y.scanResultToEntries(json, url) };
      } catch {
        return { ok: false, error: 'yt-dlp gave an answer browseDL couldn\'t read.' };
      }
    }),
  };
}

/** Which of these links does yt-dlp know how to download? One yt-dlp run checks them all. */
function checkLinks(urls, pageUrl) {
  const generic = process.env.BROWSEDL_TEST_GENERIC_LINKS === '1'; // lets tests use a local site
  const job = ytdlpJob({ authUrl: pageUrl, timeout: 90000, build: (o) => Y.linkCheckArgs({ urls, siteOnly: !generic, ...o }) });
  return {
    cancel: job.cancel,
    result: job.result.then((r) => {
      if (r.cancelled) return { ok: false };
      return { ok: true, recognised: Y.recognisedLinks(r.out, urls) };
    }),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    title: 'browseDL',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a2029' : '#eef1f5',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  browser = new Browser({ win, settings, scanPage, checkLinks });
  browser.on('tabs', (s) => send('tabs', s));
  browser.on('media', (m) => send('media', m ? { ...m, downloaded: downloadedFlags(m) } : m));
  browser.on('toast', (m) => toast(m));
  browser.on('focus-address', () => send('focus-address'));
  browser.on('open-catch', () => send('open-catch'));
  browser.on('file-saved', (p) => toast(`Saved ${path.basename(p)} to ${path.dirname(p)}`));
  browser.on('download-request', (e) => {
    const r = queue.add([{ ...e, format: e.media === 'audio' && settings().format !== 'mp3' && settings().format !== 'm4a' ? 'audio' : settings().format, collection: null }], { force: true });
    toast(r.added ? 'Added to the queue' : 'That\'s already in the queue');
  });
  win.on('resize', () => browser.layout());
  win.on('enter-full-screen', () => browser.layout());
  win.on('leave-full-screen', () => browser.layout());
  win.on('closed', () => { win = null; });
  browser.newTab(settings().homePage);
}

/** For each caught item and listed entry: has it been downloaded before? */
function downloadedFlags(m) {
  const media = m.media.map((x) => library.has([mediaKey(x.url)]));
  const entries = (m.scan && m.scan.entries ? m.scan.entries : []).map((e) => library.has(entryKeys(e, m.scan.extractor)));
  const linked = (m.linked && m.linked.groups ? m.linked.groups : []).map((g) => g.links.map((l) => library.has([mediaKey(l.url)])));
  return { media, entries, linked };
}

function entryKeys(e, extractor) {
  const keys = [e.playlistItem ? `${mediaKey(e.url)}#${e.playlistItem}` : mediaKey(e.url)];
  if (e.id && extractor) keys.push(`${String(extractor).toLowerCase()}:${e.id}`);
  return keys;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tab = (fn) => () => browser && fn(browser);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: tab((b) => { b.newTab(); send('show-view', 'browse'); }) },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: tab((b) => b.activeId && b.close(b.activeId)) },
        { label: 'Open address bar', accelerator: 'CmdOrCtrl+L', click: () => send('focus-address') },
        { type: 'separator' },
        { label: 'Open download folder', click: () => openDownloadFolder() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Browse', accelerator: 'CmdOrCtrl+1', click: () => send('show-view', 'browse') },
        { label: 'Queue', accelerator: 'CmdOrCtrl+2', click: () => send('show-view', 'queue') },
        { label: 'Library', accelerator: 'CmdOrCtrl+3', click: () => send('show-view', 'library') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('show-view', 'settings') },
        { type: 'separator' },
        { label: 'Reload page', accelerator: 'CmdOrCtrl+R', click: tab((b) => b.go(null, 'reload')) },
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: tab((b) => b.go(null, 'back')) },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: tab((b) => b.go(null, 'forward')) },
        { type: 'separator' },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: tab((b) => cycleTab(b, 1)) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: tab((b) => cycleTab(b, -1)) },
        { type: 'separator' },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: tab((b) => zoomPage(b, 0)) },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: tab((b) => zoomPage(b, 1)) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: tab((b) => zoomPage(b, -1)) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'browseDL on GitHub', click: () => shell.openExternal('https://github.com/terpenesalad/browseDL') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Zoom the web page, not browseDL's own interface. */
function zoomPage(b, dir) {
  const t = b.active();
  if (!t) return;
  const wc = t.view.webContents;
  wc.setZoomLevel(dir === 0 ? 0 : Math.max(-4, Math.min(5, wc.getZoomLevel() + dir * 0.5)));
}

function cycleTab(b, dir) {
  if (!b.tabs.length) return;
  const i = b.tabs.findIndex((t) => t.id === b.activeId);
  b.activate(b.tabs[(i + dir + b.tabs.length) % b.tabs.length].id);
}

function rememberDir(dir) {
  if (!dir || dir === settings().downloadDir) return settings();
  const list = [dir, ...(settings().recentDirs || []).filter((d) => d !== dir)].slice(0, 6);
  settingsStore.data.recentDirs = list;
  settingsStore.save();
  send('settings', settings());
  return settings();
}

function openDownloadFolder() {
  const dir = settings().downloadDir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function wireIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  h('state', async () => ({
    settings: settings(),
    formats: Object.fromEntries(Object.entries(Y.FORMATS).map(([k, v]) => [k, v.label])),
    layouts: LAYOUTS,
    browsers: Y.BROWSERS,
    platform: process.platform,
    version: app.getVersion(),
    tabs: browser.tabsState(),
    media: browser.mediaState(),
    queue: queue.list(),
    library: library.list(),
  }));
  h('versions', () => bins.versions());

  // browser
  h('tab:new', (url) => { browser.newTab(url); });
  h('tab:close', (id) => browser.close(id));
  h('tab:activate', (id) => browser.activate(id));
  h('tab:navigate', (id, input) => browser.navigate(id, input));
  h('tab:go', (id, what) => browser.go(id, what));
  h('tab:media', (id) => {
    const m = browser.mediaState(id);
    return m ? { ...m, downloaded: downloadedFlags(m) } : null;
  });
  h('tab:rescan', async (id) => {
    const tab = browser.get(id) || browser.active();
    if (!tab) return;
    await browser.domScan(tab).catch(() => {});
    browser.siteScan(tab, { force: true });
  });
  h('browser:bounds', (rect) => browser.setBounds(rect));
  h('scan:list', async (url) => {
    const r = await scanPage(url, { siteOnly: false }).result;
    if (r.ok) r.downloaded = r.entries.map((e) => library.has(entryKeys(e, r.extractor)));
    return r;
  });

  // queue
  h('queue:add', (items, opts) => queue.add(items, opts));
  h('queue:action', (name, ids) => queue.action(name, ids));
  h('queue:addLinks', async (text, opts = {}) => {
    const urls = [...new Set(String(text).split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))];
    let added = 0;
    let already = 0;
    const failed = [];
    for (const url of urls) {
      const r = await scanPage(url).result;
      let entries;
      if (r.ok && r.entries.length) {
        const flat = r.entries.filter((e) => !e.isList && !e.live);
        entries = flat.map((e) => ({
          url: e.url, title: e.title, kind: 'page', media: 'unknown', pageUrl: e.url, thumbnail: e.thumbnail, duration: e.duration,
          collection: r.title || e.uploader || null, keys: entryKeys(e, r.extractor), site: siteName(url), format: opts.format,
          playlistItem: e.playlistItem || null, root: opts.root || null,
        }));
        if (!flat.length) failed.push(url);
      } else {
        failed.push(url);
        continue;
      }
      const res = queue.add(entries, { force: opts.force });
      added += res.added;
      already += res.already;
    }
    return { added, already, failed };
  });

  // library
  h('library:open', (id) => {
    const r = library.items.find((x) => x.id === id);
    if (r) return shell.openPath(r.file);
  });
  h('library:reveal', (id) => {
    const r = library.items.find((x) => x.id === id);
    if (r) shell.showItemInFolder(r.file);
  });
  h('library:remove', (ids, trash) => library.remove(ids, { trash: trash ? (f) => shell.trashItem(f) : null }));
  h('library:move', (ids, collection) => library.move(ids, collection));
  h('library:rename', (id, title) => library.rename(id, title));
  h('library:forgetMissing', () => library.forgetMissing());
  h('library:openPage', (url) => { browser.newTab(url); });

  // settings and app
  h('settings:set', (patch) => {
    const allowed = Object.keys(defaults());
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) settingsStore.data[k] = v;
    settingsStore.save();
    if ('concurrency' in patch) queue.pump();
    if ('minSizeKB' in patch) for (const t of browser.tabs) browser._emitMedia(t);
    send('settings', settings());
    return settings();
  });
  // A download folder for one batch; remembered in the "Save in" list.
  h('folder:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save these downloads in', defaultPath: settings().downloadDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    rememberDir(r.filePaths[0]);
    return r.filePaths[0];
  });
  h('folder:remember', (dir) => rememberDir(dir));
  h('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save downloads in', defaultPath: settings().downloadDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settingsStore.data.downloadDir = r.filePaths[0];
    settingsStore.save();
    send('settings', settings());
    return r.filePaths[0];
  });
  h('app:openFolder', () => openDownloadFolder());
  h('app:updateYtdlp', () => bins.update());
  h('app:clearBrowsing', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Log out of everything', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Log out of every site in browseDL?', detail: 'This clears the built-in browser\'s cookies, saved logins and cache. Your downloads and library stay as they are.',
    });
    if (r.response !== 0) return false;
    await browser.clearData();
    return true;
  });
  h('app:openExternal', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
}

async function main() {
  await app.whenReady();
  settingsStore = new JsonStore(path.join(userDir(), 'settings.json'), defaults());
  bins = new Bins({ resourcesDir: process.resourcesPath, devDir: path.join(__dirname, '..', '..'), userDir: userDir(), packaged: app.isPackaged });

  if (SELF_TEST) {
    const { selfTest } = require('./selftest');
    const code = await selfTest({ bins, settings });
    app.exit(code);
    return;
  }

  library = new Library(new JsonStore(path.join(userDir(), 'library.json'), []), settings);
  buildMenu();
  createWindow();
  queue = new Queue({
    store: new JsonStore(path.join(userDir(), 'queue.json'), []),
    settings, bins, library,
    getCookies: () => browser.cookies(),
    authFor,
    userAgent: () => browser.userAgent,
    workDir: path.join(userDir(), 'work'),
  });
  queue.on('list', (l) => send('queue', l));
  queue.on('items', (l) => send('queue:items', l));
  library.on('changed', () => {
    clearTimeout(main._libTimer);
    main._libTimer = setTimeout(() => {
      send('library', library.list());
      for (const t of browser.tabs) browser._emitMedia(t);
    }, 150);
  });
  wireIpc();
  bins.ytdlp().then(() => queue.pump());

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('before-quit', () => {
    queue.shutdown();
    settingsStore.saveNow();
    library.store.saveNow();
  });
  app.on('window-all-closed', () => app.quit());
}

main();
