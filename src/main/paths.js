'use strict';
// Where downloads go, and making names safe for every operating system.
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make text safe as one file or folder name on Windows, macOS and Linux. */
function safeName(name, fallback = 'Untitled', max = 120) {
  let s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, (c) => ({ '<': '‹', '>': '›', ':': '꞉', '"': '”', '/': '⁄', '\\': '⧵', '|': '∣', '?': '？', '*': '＊' })[c])
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  // Trim by characters, keeping surrogate pairs whole.
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim().replace(/[. ]+$/, '');
  return s || fallback;
}

/** "www.example.co.uk" -> "example.co.uk"; falls back to "Other sites". */
function siteName(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^(www\d*|m|mobile)\./, '');
    return h || 'Other sites';
  } catch {
    return 'Other sites';
  }
}

const LAYOUTS = {
  'site-collection': 'Site, then collection',
  site: 'Site only',
  collection: 'Collection only',
  flat: 'Everything in one folder',
};

/**
 * The folder a finished download is saved in.
 * @param {{root:string, layout?:string, splitByType?:boolean, media:'audio'|'video', site:string, collection?:string}} o
 */
function outputDir(o) {
  const parts = [o.root];
  if (o.splitByType) parts.push(o.media === 'audio' ? 'Audio' : 'Video');
  const site = safeName(o.site, 'Other sites', 80);
  const coll = o.collection ? safeName(o.collection, 'Unsorted', 100) : null;
  switch (o.layout || 'site-collection') {
    case 'flat':
      break;
    case 'site':
      parts.push(site);
      break;
    case 'collection':
      parts.push(coll || site);
      break;
    default:
      parts.push(site);
      if (coll) parts.push(coll);
  }
  return path.join(...parts);
}

/** yt-dlp output templates treat % specially; escape a literal name. */
function templateLiteral(s) {
  return String(s).replace(/%/g, '%%');
}

module.exports = { safeName, siteName, outputDir, templateLiteral, LAYOUTS };
