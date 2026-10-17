'use strict';
// Hand the built-in browser's logins to yt-dlp as a Netscape cookies.txt file.
const fs = require('fs');

/**
 * Convert Electron cookies to the Netscape cookies.txt format that yt-dlp reads.
 * @param {Electron.Cookie[]} cookies
 */
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Written by browseDL for one download; deleted afterwards.', ''];
  for (const c of cookies) {
    if (!c || !c.name || !c.domain) continue;
    const value = String(c.value ?? '');
    if (/[\t\r\n]/.test(c.name) || /[\t\r\n]/.test(value)) continue;
    let domain = c.domain;
    const hostOnly = c.hostOnly === true || (c.hostOnly === undefined && !domain.startsWith('.'));
    if (hostOnly) domain = domain.replace(/^\./, '');
    else if (!domain.startsWith('.')) domain = '.' + domain;
    const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + domain,
      hostOnly ? 'FALSE' : 'TRUE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(expiry),
      c.name,
      value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Write cookies to a file only this user can read. */
function writeCookieFile(file, cookies) {
  fs.writeFileSync(file, toNetscape(cookies), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

module.exports = { toNetscape, writeCookieFile };
