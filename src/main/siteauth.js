'use strict';
// Sites where yt-dlp can't use cookies and needs a login token instead. browseDL reads the token
// from the built-in browser (where you're logged in) and hands it to yt-dlp in a temporary .netrc.
const fs = require('fs');

const SITES = [
  {
    id: 'dch',
    name: 'Digital Concert Hall',
    hosts: /(^|\.)digitalconcerthall\.com$/i,
    origin: 'https://www.digitalconcerthall.com',
    // Opening the site lets its own code refresh an expired token.
    refreshUrl: 'https://www.digitalconcerthall.com/en/',
    storageKeys: ['access_token_production'],
    netrcMachine: 'digitalconcerthall',
    netrcLogin: 'token',
  },
];

function siteFor(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return SITES.find((s) => s.hosts.test(host)) || null;
}

/** Local storage may hold the bare token, a JSON string, or an object with access_token. */
function cleanToken(raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  if (!v || v === 'null' || v === 'undefined') return null;
  if (v.startsWith('"') || v.startsWith('{')) {
    try {
      const j = JSON.parse(v);
      v = typeof j === 'string' ? j : j && (j.access_token || j.token || j.value) || '';
    } catch { /* not JSON */ }
  }
  v = String(v).trim();
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(v) ? v : null;
}

/** Seconds since 1970 when a JWT expires, or null if it can't be read. */
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Still good for at least `margin` seconds? Tokens without an expiry are assumed good. */
function tokenFresh(token, margin = 120, now = Date.now() / 1000) {
  const exp = jwtExpiry(token);
  return exp == null || exp - margin > now;
}

function netrcText(machine, login, password) {
  return `machine ${machine} login ${login} password ${password}\n`;
}

function writeNetrc(file, site, token) {
  fs.writeFileSync(file, netrcText(site.netrcMachine, site.netrcLogin, token), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  // --no-cache-dir stops yt-dlp keeping its own copy of the token on disk.
  return ['--netrc', '--netrc-location', file, '--no-cache-dir'];
}

module.exports = { SITES, siteFor, cleanToken, jwtExpiry, tokenFresh, netrcText, writeNetrc };
