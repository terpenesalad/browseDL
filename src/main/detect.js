'use strict';
// Deciding which network responses and page elements are downloadable media.
// Everything here is pure so it can be unit tested without Electron.

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv', '3gp', 'wmv', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba', 'wma', 'aiff', 'aif', 'mka', 'alac', 'm4b']);
// Pieces of a stream rather than whole files.
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'fmp4', 'vtt', 'webvtt', 'srt', 'key', 'aac_seg']);
const SEGMENT_MIME = new Set(['video/mp2t', 'video/iso.segment', 'audio/mp2t', 'text/vtt']);
const HLS_MIME = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);
const DASH_MIME = new Set(['application/dash+xml']);
// Hosts whose raw media requests are only ever fragments; the page itself is handled by yt-dlp.
const FRAGMENT_HOSTS = [/\.googlevideo\.com$/i, /^rr\d+---/i, /\.fbcdn\.net$/i, /\.cdninstagram\.com$/i, /\.tiktokcdn(-us)?\.com$/i];
// Query parameters that change between requests for the same file (signatures, byte ranges, cache busters).
const VOLATILE_PARAMS = new Set([
  'token', 'expires', 'exp', 'signature', 'sig', 'policy', 'key-pair-id', 'range', 'bytestart', 'byteend',
  '_', 't', 'ts', 'hdnts', 'hdnea', 'validfrom', 'validto', 'hash', 'st', 'e', 'x-amz-signature',
  'x-amz-date', 'x-amz-credential', 'x-amz-expires', 'x-amz-security-token', 'x-amz-signedheaders', 'cb', 'rnd',
]);

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const last = p.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot > 0 ? decodeURIComponent(last.slice(dot + 1)).toLowerCase() : '';
  } catch {
    return '';
  }
}

function cleanMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/**
 * Classify a network response.
 * @param {{url:string, mime?:string, status?:number}} r
 * @returns {null | {kind:'hls'|'dash'|'file', media:'video'|'audio'|'unknown', ext:string}}
 */
function classifyResponse(r) {
  const url = r.url || '';
  if (!/^https?:/i.test(url)) return null;
  if (r.status && (r.status < 200 || r.status >= 300)) return null;
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (FRAGMENT_HOSTS.some((re) => re.test(host))) return null;

  const mime = cleanMime(r.mime);
  const ext = extOf(url);
  if (SEGMENT_EXT.has(ext) || SEGMENT_MIME.has(mime)) return null;
  if (HLS_MIME.has(mime) || ext === 'm3u8') return { kind: 'hls', media: mime.startsWith('audio/') ? 'audio' : 'unknown', ext: 'm3u8' };
  if (DASH_MIME.has(mime) || ext === 'mpd') return { kind: 'dash', media: 'unknown', ext: 'mpd' };
  if (looksLikeSegmentPath(url)) return null;
  if (mime === 'text/html' || mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/json') return null;
  if (mime.startsWith('video/')) return { kind: 'file', media: 'video', ext: ext || mime.slice(6) };
  if (mime.startsWith('audio/')) return { kind: 'file', media: 'audio', ext: ext || mime.slice(6) };
  if (VIDEO_EXT.has(ext)) return { kind: 'file', media: 'video', ext };
  if (AUDIO_EXT.has(ext)) return { kind: 'file', media: 'audio', ext };
  return null;
}

// Common names for stream fragments that are served with a normal media type.
function looksLikeSegmentPath(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = u.pathname.toLowerCase();
  if (/(^|\/)(seg|segment|chunk|frag|fragment)[-_]?\d+[^/]*$/.test(p)) return true;
  if (/\/(init|header)\.(mp4|m4a|m4v|webm)$/.test(p)) return true;
  if (/[-_.](seg|frag|chunk)\d+\./.test(p)) return true;
  if (u.searchParams.has('range') && /\d+-\d+/.test(u.searchParams.get('range') || '')) return true;
  return false;
}

/** A stable key for "the same file", ignoring signatures and byte ranges in the query. */
function mediaKey(url) {
  try {
    const u = new URL(url);
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (!VOLATILE_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const q = keep.map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${q ? '?' + q : ''}`;
  } catch {
    return url;
  }
}

/** Total size of a response, from Content-Range for partial responses or Content-Length otherwise. */
function sizeFromHeaders(headers, status) {
  const h = lowerHeaders(headers);
  const range = h['content-range'];
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return Number(m[1]);
  }
  if (status === 200 && h['content-length']) {
    const n = Number(h['content-length']);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Electron gives headers as {name: [values]} with any capitalisation. */
function lowerHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * Read an HLS playlist.
 * @returns {{master:boolean, variants:{url:string, height:number|null, bandwidth:number|null, audioOnly:boolean}[], audioRenditions:string[], duration:number|null, drm:boolean}}
 */
function parseM3u8(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  const res = { master: false, variants: [], audioRenditions: [], duration: null, drm: false };
  if (!lines.some((l) => l.startsWith('#EXTM3U'))) return res;
  let pending = null;
  let total = 0;
  let sawInf = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      res.master = true;
      const attrs = parseAttrs(line.slice(18));
      const resn = /(\d+)x(\d+)/.exec(attrs.RESOLUTION || '');
      const codecs = (attrs.CODECS || '').toLowerCase();
      pending = {
        height: resn ? Number(resn[2]) : null,
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
        audioOnly: !resn && codecs !== '' && !/avc|hvc|hev|vp0?9|av01|mp4v/.test(codecs),
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(line.slice(13));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) res.audioRenditions.push(resolve(attrs.URI, baseUrl));
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      const method = (attrs.METHOD || '').toUpperCase();
      const fmt = (attrs.KEYFORMAT || '').toLowerCase();
      if (method.startsWith('SAMPLE-AES') || (fmt && fmt !== 'identity')) res.drm = true;
    } else if (line.startsWith('#EXTINF:')) {
      sawInf = true;
      const d = parseFloat(line.slice(8));
      if (Number.isFinite(d)) total += d;
    } else if (line && !line.startsWith('#') && pending) {
      res.variants.push({ url: resolve(line, baseUrl), ...pending });
      pending = null;
    }
  }
  if (sawInf) res.duration = Math.round(total);
  if (res.master && res.variants.length && res.variants.every((v) => v.audioOnly)) res.audioOnlyStream = true;
  return res;
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function resolve(ref, base) {
  try { return new URL(ref, base).href; } catch { return ref; }
}

/** Read a DASH manifest just enough to know its length and whether it's DRM protected. */
function parseMpd(text) {
  const s = String(text || '');
  const drm = /<ContentProtection[^>]*(cenc|widevine|playready|edef8ba9|9a04f079)/i.test(s);
  let duration = null;
  const m = /mediaPresentationDuration="P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/.exec(s);
  if (m) duration = Math.round((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0));
  const hasVideo = /mimeType="video\//.test(s) || /contentType="video"/.test(s);
  const hasAudio = /mimeType="audio\//.test(s) || /contentType="audio"/.test(s);
  return { drm, duration, media: hasVideo ? 'video' : hasAudio ? 'audio' : 'unknown' };
}

/** Is this link (from an <a href>) a media file worth listing? */
function classifyLink(href) {
  const ext = extOf(href);
  if (VIDEO_EXT.has(ext)) return { kind: 'file', media: 'video', ext };
  if (AUDIO_EXT.has(ext)) return { kind: 'file', media: 'audio', ext };
  if (ext === 'm3u8') return { kind: 'hls', media: 'unknown', ext };
  if (ext === 'mpd') return { kind: 'dash', media: 'unknown', ext };
  return null;
}

/** A readable name from a URL's file name, e.g. ".../Episode%2012.mp3" -> "Episode 12". */
function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const dec = decodeURIComponent(last);
    const dot = dec.lastIndexOf('.');
    const base = (dot > 0 ? dec.slice(0, dot) : dec).replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base || null;
  } catch {
    return null;
  }
}

// This runs inside the browsed page (in an isolated world) to list <video>, <audio> and links to media files.
const PAGE_SCAN_SCRIPT = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const out = { title: document.title, url: location.href, elements: [], links: [], meta: [], pages: [] };
  const seen = new Set();
  for (const el of document.querySelectorAll('video, audio')) {
    const srcs = [el.currentSrc, el.src, ...[...el.querySelectorAll('source')].map((s) => s.src)];
    for (const s of srcs) {
      const u = s && abs(s);
      if (!u || !/^https?:/.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.elements.push({ url: u, tag: el.tagName.toLowerCase(), poster: el.poster || null,
        duration: Number.isFinite(el.duration) ? Math.round(el.duration) : null,
        label: el.getAttribute('title') || el.getAttribute('aria-label') || null });
    }
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const u = abs(a.getAttribute('href'));
    if (!u || !/^https?:/.test(u) || seen.has(u)) continue;
    if (!/\\.(mp4|m4v|webm|mov|mkv|avi|flv|ogv|3gp|wmv|mpg|mpeg|mp3|m4a|aac|ogg|oga|opus|flac|wav|weba|wma|aiff|aif|mka|m4b|m3u8|mpd)([?#]|$)/i.test(u)) {
      // Links to other pages on this site, which may be video pages (checked later with yt-dlp).
      if (out.pages.length < 600) {
        const lines = (a.innerText || '').split('\\n').map((l) => l.replace(/\\s+/g, ' ').trim()).filter(Boolean);
        const img = a.querySelector('img[alt]');
        const text = lines.slice(0, 2).join(' – ') || a.getAttribute('title') || a.getAttribute('aria-label') || (img && img.alt) || '';
        out.pages.push({ url: u, text: text.slice(0, 200) || null });
      }
      continue;
    }
    seen.add(u);
    out.links.push({ url: u, text: (a.textContent || a.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 200) || null });
  }
  for (const m of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[property="og:audio"], meta[property="og:audio:secure_url"], meta[name="twitter:player:stream"]')) {
    const u = abs(m.getAttribute('content') || '');
    if (u && /^https?:/.test(u) && !seen.has(u)) { seen.add(u); out.meta.push({ url: u }); }
  }
  return out;
})()`;

/**
 * Group a page's links to other pages on the same site by URL shape, e.g. every /en/concert/123
 * link together, so one link from each group can be checked with yt-dlp.
 * @returns {{pattern:string, label:string, links:{url:string,title:string|null}[]}[]} biggest groups first
 */
function groupLinks(links, pageUrl, { maxGroups = 15 } = {}) {
  let page;
  try { page = new URL(pageUrl); } catch { return []; }
  const bare = (h) => h.toLowerCase().replace(/^www\./, '');
  const groups = new Map();
  const seen = new Set();
  for (const l of links || []) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || bare(u.hostname) !== bare(page.hostname)) continue;
    u.hash = '';
    const href = u.href;
    if (href === page.href.split('#')[0]) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length && !u.search) continue; // the home page
    if (segs.length === 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]) && !u.search) continue; // a language's home page
    const keys = [...u.searchParams.keys()].sort();
    // The last part of the path (or the query values) is what changes from video to video.
    const shape = segs.map((s, i) => (i === segs.length - 1 && !keys.length ? '*' : /\d/.test(s) && /^[\w-]+$/.test(s) && s.length > 2 && /\d{2,}/.test(s) ? '#' : s.toLowerCase()));
    const pattern = `/${shape.join('/')}${keys.length ? '?' + keys.map((k) => `${k}=*`).join('&') : ''}`;
    if (seen.has(href)) {
      const g = groups.get(pattern);
      const existing = g && g.links.find((x) => x.url === href);
      if (existing && !existing.title && l.text) existing.title = l.text;
      continue;
    }
    seen.add(href);
    if (!groups.has(pattern)) {
      const named = [...segs].reverse().find((s, i) => (i > 0 || keys.length) && !/\d{2,}/.test(s) && !/^[a-z]{2}(-[a-z]{2})?$/i.test(s));
      groups.set(pattern, { pattern, label: (named || (keys.length ? segs[segs.length - 1] : null) || bare(page.hostname)).replace(/[-_]+/g, ' '), links: [] });
    }
    groups.get(pattern).links.push({ url: href, title: l.text || null });
  }
  return [...groups.values()].sort((a, b) => b.links.length - a.links.length).slice(0, maxGroups);
}

module.exports = {
  groupLinks,
  classifyResponse,
  classifyLink,
  looksLikeSegmentPath,
  mediaKey,
  sizeFromHeaders,
  lowerHeaders,
  parseM3u8,
  parseMpd,
  nameFromUrl,
  extOf,
  PAGE_SCAN_SCRIPT,
  VIDEO_EXT,
  AUDIO_EXT,
};
