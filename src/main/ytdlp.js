'use strict';
// Building yt-dlp command lines, reading its output, and running it.
const { spawn } = require('child_process');

const FORMATS = {
  best: { label: 'Best quality video', audio: false },
  1080: { label: 'Video up to 1080p', audio: false },
  720: { label: 'Video up to 720p', audio: false },
  480: { label: 'Video up to 480p', audio: false },
  mp3: { label: 'Audio only (MP3)', audio: true },
  m4a: { label: 'Audio only (M4A)', audio: true },
  audio: { label: 'Audio only (original format)', audio: true },
};

const BROWSERS = ['chrome', 'firefox', 'edge', 'brave', 'safari', 'opera', 'vivaldi', 'chromium', 'whale'];

function formatArgs(fmt) {
  switch (fmt) {
    case 'mp3':
      return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    case 'm4a':
      return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a'];
    case 'audio':
      return ['-f', 'ba/b', '-x'];
    case '1080':
    case '720':
    case '480':
      // Highest resolution not above the cap, preferring H.264/AAC because they play everywhere.
      return ['-f', 'bv*+ba/b', '-S', `res:${fmt},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4/mkv'];
    default:
      return ['-f', 'bv*+ba/b', '-S', 'res,fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4/mkv'];
  }
}

const PROGRESS_TEMPLATE =
  'download:BDL_DL %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|' +
  '%(progress.fragment_count)s|%(info.format_id)s';

/**
 * The full argument list for downloading one item.
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.format  key of FORMATS
 * @param {string} o.homeDir  final folder
 * @param {string} o.tempDir  folder for partial files
 * @param {string} o.outName  output template (already escaped), without extension
 * @param {string} [o.cookieFile]
 * @param {string} [o.cookiesFromBrowser]
 * @param {string} [o.userAgent]
 * @param {object} [o.headers]  extra request headers, e.g. Referer
 * @param {string} [o.ffmpegDir]
 * @param {boolean} [o.isDirect] a media file or stream URL rather than a web page
 * @param {string} [o.pathFile] yt-dlp writes the saved file's path here (UTF-8)
 */
function downloadArgs(o) {
  const a = [
    '--newline', '--no-simulate', '--quiet', '--progress', '--no-color',
    '--progress-template', PROGRESS_TEMPLATE,
    '--progress-template', 'postprocess:BDL_PP %(progress.status)s|%(progress.postprocessor)s',
    '--print', 'video:BDL_META %(.{title,id,format_id,extractor_key,duration,thumbnail,webpage_url,ext,uploader,playlist_title})j',
    '--print', 'after_move:BDL_FILE %(filepath)s',
    '--encoding', 'utf-8',
    '--no-mtime', '--no-playlist', '--no-overwrites', '--continue',
    '--retries', '10', '--fragment-retries', '10', '--concurrent-fragments', '4',
    '--embed-metadata',
    '-P', `home:${o.homeDir}`,
    '-P', `temp:${o.tempDir}`,
    '-o', `${o.outName}.%(ext)s`,
    ...formatArgs(o.format),
  ];
  if ((o.format === 'mp3' || o.format === 'm4a') && !o.isDirect) a.push('--embed-thumbnail');
  if (o.pathFile) a.push('--print-to-file', 'after_move:%(filepath)s', o.pathFile.replace(/%/g, '%%'));
  if (o.ffmpegDir) a.push('--ffmpeg-location', o.ffmpegDir);
  if (o.cookiesFromBrowser) a.push('--cookies-from-browser', o.cookiesFromBrowser);
  else if (o.cookieFile) a.push('--cookies', o.cookieFile);
  if (o.userAgent) a.push('--user-agent', o.userAgent);
  for (const [k, v] of Object.entries(o.headers || {})) {
    if (v && /^[A-Za-z-]+$/.test(k) && !/[\r\n]/.test(v)) a.push('--add-header', `${k}:${v}`);
  }
  if (o.isDirect) a.push('--force-generic-extractor');
  a.push('--', o.url);
  return a;
}

/** Arguments to list what's on a page without downloading. */
function scanArgs(o) {
  const a = ['-J', '--flat-playlist', '--no-warnings', '--no-color', '--playlist-end', String(o.limit || 2000)];
  if (o.siteOnly) a.push('--ies', 'default,-generic');
  if (o.cookiesFromBrowser) a.push('--cookies-from-browser', o.cookiesFromBrowser);
  else if (o.cookieFile) a.push('--cookies', o.cookieFile);
  if (o.userAgent) a.push('--user-agent', o.userAgent);
  a.push('--', o.url);
  return a;
}

const num = (s) => (s === undefined || s === 'NA' || s === 'None' || s === '' ? null : Number(s));

/**
 * Turn one line of yt-dlp output into an event.
 * @returns {null | {type:'progress', ...} | {type:'pp', ...} | {type:'meta', meta:object} | {type:'file', path:string} | {type:'error', message:string} | {type:'warning', message:string}}
 */
function parseLine(line) {
  const s = String(line).replace(/\r$/, '');
  if (s.startsWith('BDL_DL ')) {
    const [status, done, total, estimate, speed, eta, fragIndex, fragCount, formatId] = s.slice(7).split('|');
    return {
      type: 'progress', status,
      downloaded: num(done), total: num(total) ?? num(estimate),
      speed: num(speed), eta: num(eta),
      fragIndex: num(fragIndex), fragCount: num(fragCount), formatId: formatId || null,
    };
  }
  if (s.startsWith('BDL_PP ')) {
    const [status, pp] = s.slice(7).split('|');
    return { type: 'pp', status, postprocessor: pp };
  }
  if (s.startsWith('BDL_META ')) {
    try { return { type: 'meta', meta: JSON.parse(s.slice(9)) }; } catch { return null; }
  }
  if (s.startsWith('BDL_FILE ')) return { type: 'file', path: s.slice(9).trim() };
  if (s.startsWith('ERROR: ')) return { type: 'error', message: s.slice(7).trim() };
  if (s.startsWith('WARNING: ')) return { type: 'warning', message: s.slice(9).trim() };
  return null;
}

/**
 * Overall progress across the separate video and sound downloads of one item.
 * Keeps state between progress events.
 */
class ProgressTracker {
  constructor() {
    this.parts = 1;
    this.index = 0;
    this.lastFormat = null;
    this.lastFinished = false;
  }
  setFormat(formatId) {
    if (formatId) this.parts = Math.max(1, String(formatId).split('+').length);
  }
  update(ev) {
    if (this.lastFormat && ev.formatId && ev.formatId !== this.lastFormat && this.lastFinished) {
      this.index = Math.min(this.index + 1, this.parts - 1);
    }
    if (ev.formatId) this.lastFormat = ev.formatId;
    this.lastFinished = ev.status === 'finished';
    let frac = null;
    if (ev.fragCount && ev.fragIndex != null && !(ev.total && ev.downloaded)) frac = ev.fragIndex / ev.fragCount;
    else if (ev.total && ev.downloaded != null) frac = ev.downloaded / ev.total;
    if (ev.status === 'finished') frac = 1;
    if (frac == null) return null;
    frac = Math.max(0, Math.min(1, frac));
    return (this.index + frac) / this.parts;
  }
}

/** Plain-words explanations for yt-dlp errors. */
function friendlyError(msg) {
  const m = String(msg || '');
  const low = m.toLowerCase();
  if (/drm|widevine|playready|fairplay/.test(low)) return 'This is DRM-protected, so it can\'t be saved.';
  if (/http error 403|forbidden/.test(low)) return 'The site refused the download (403). Open the page in Browse, play it for a moment, then queue it again so browseDL gets a fresh link.';
  if (/http error 401|login required|sign in|log in|logged in|members[- ]only|cookies/.test(low) && !/cookies-from-browser.*could not/.test(low)) return 'This needs you to be logged in. Log in to the site in Browse, then retry.';
  if (/could not (find|copy|decrypt).*cookie|cookie database|failed to decrypt with dpapi/.test(low)) return 'Couldn\'t read your other browser\'s logins. Close that browser and retry, or switch "Logins from" to browseDL in Settings.';
  if (/http error 404|not found/.test(low)) return 'The file is gone (404). Open the page again and re-queue it.';
  if (/http error 410|expired/.test(low)) return 'The link has expired. Open the page again in Browse and re-queue it.';
  if (/unsupported url|no suitable extractor/.test(low)) return 'No media found at this link.';
  if (/ffmpeg|ffprobe/.test(low) && /not (found|installed)|failed|error/.test(low)) return 'Joining or converting the file with ffmpeg failed: ' + m;
  if (/timed out|timeout|connection reset|network is unreachable|getaddrinfo|name resolution/.test(low)) return 'The connection dropped. Retry when you\'re back online.';
  if (/no space left/.test(low)) return 'The disk is full.';
  if (/private video|video unavailable|not available/.test(low)) return 'The site says this isn\'t available: ' + m;
  return m || 'The download failed.';
}

/**
 * Run a binary, streaming stdout and stderr lines.
 * @returns {{child: import('child_process').ChildProcess, done: Promise<{code:number|null, signal:string|null}>}}
 */
function run(bin, args, { env, onLine, onErrLine, cwd } = {}) {
  const child = spawn(bin, args, {
    env,
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = (stream, cb) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
        if (cb) cb(line);
      }
    });
    stream.on('end', () => { if (buf && cb) cb(buf); });
  };
  lines(child.stdout, onLine);
  lines(child.stderr, onErrLine);
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, signal: null, error: err }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

/** Stop a process and everything it started (yt-dlp runs ffmpeg). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

/**
 * Turn yt-dlp's -J output into a flat list of things that can be queued.
 * Entries that are themselves lists (a channel's "Videos" tab, say) come back with isList.
 */
function scanResultToEntries(info) {
  if (!info) return { title: null, entries: [] };
  const thumb = (e) => e.thumbnail || (Array.isArray(e.thumbnails) && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : null);
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = [];
    for (const e of info.entries || []) {
      if (!e) continue;
      const url = e.url || e.webpage_url || e.original_url;
      if (!url) continue;
      const listyExtractor = /tab|playlist|channel|user|album|set/i.test(e.ie_key || '');
      const isList = e._type === 'playlist' || (listyExtractor && !e.duration && !/watch\?v=|\/shorts\//.test(url));
      entries.push({
        url: absolutise(url, info.webpage_url),
        title: e.title || e.id || url,
        id: e.id || null,
        duration: e.duration || null,
        thumbnail: thumb(e),
        uploader: e.uploader || e.channel || null,
        live: e.live_status === 'is_live' || e.live_status === 'is_upcoming',
        availability: e.availability || null,
        isList,
      });
    }
    return { title: info.title || null, uploader: info.uploader || info.channel || null, extractor: info.extractor_key || null, entries };
  }
  return {
    title: null,
    extractor: info.extractor_key || null,
    entries: [{
      url: info.webpage_url || info.original_url || info.url,
      title: info.title || info.id,
      id: info.id || null,
      duration: info.duration || null,
      thumbnail: thumb(info),
      uploader: info.uploader || info.channel || null,
      live: info.live_status === 'is_live' || info.live_status === 'is_upcoming',
      availability: info.availability || null,
      isList: false,
    }],
  };
}

function absolutise(url, base) {
  try { return new URL(url, base || undefined).href; } catch { return url; }
}

module.exports = {
  FORMATS, BROWSERS, formatArgs, downloadArgs, scanArgs, parseLine, ProgressTracker,
  friendlyError, run, killTree, scanResultToEntries,
};
