'use strict';
// A tiny members-only "site" for end-to-end tests: a login page, and a members page with
// a video, an audio player, links to episode files and an HLS stream, all behind the login cookie.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function makeMedia(dir, ffmpeg = 'ffmpeg') {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => execFileSync(ffmpeg, ['-loglevel', 'error', '-y', ...args]);
  if (!fs.existsSync(path.join(dir, 'clip.mp4'))) {
    run(['-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'clip.mp4')]);
    for (const [n, f] of [['song', 523], ['ep1', 330], ['ep2', 392]]) {
      run(['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=20`, '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, `${n}.mp3`)]);
    }
    run(['-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'big.mp4')]);
    fs.copyFileSync(path.join(dir, 'big.mp4'), path.join(dir, 'big2.mp4'));
    fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
    run(['-i', path.join(dir, 'clip.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(dir, 'hls', 'index.m3u8')]);
  }
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222}video{width:100%;background:#000}a{color:#0645ad}</style>
</head><body>${body}</body></html>`;

function start(dir, port = 0) {
  const types = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const loggedIn = /(^|;\s*)member=yes/.test(req.headers.cookie || '');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Night Radio', `<h1>Night Radio</h1><p>Members get every episode.</p>
        <p><a href="/login">Log in</a> · <a href="/members">Members area</a></p>`));
      return;
    }
    if (url.pathname === '/login') {
      if (req.method === 'POST' || url.searchParams.get('auto')) {
        res.writeHead(302, { 'set-cookie': 'member=yes; Path=/; HttpOnly; Max-Age=86400', location: '/members' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Log in', `<h1>Log in</h1>
        <form method="post"><p><input name="u" placeholder="Name"> <input name="p" type="password" placeholder="Password"></p><button>Log in</button></form>`));
      return;
    }
    if (url.pathname === '/members') {
      if (!loggedIn) { res.writeHead(302, { location: '/login' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Night Radio – Members', `<h1>Night Radio: members</h1>
        <h2>This week's video</h2><video controls muted autoplay src="/media/clip.mp4"></video>
        <h2>Theme tune</h2><audio controls src="/media/song.mp3" title="Theme tune"></audio>
        <h2>Episodes</h2><ul>
          <li><a href="/media/ep1.mp3">Episode 1: Owls</a></li>
          <li><a href="/media/ep2.mp3">Episode 2: Foxes</a></li>
          <li><a href="/media/hls/index.m3u8">Live archive (stream)</a></li>
        </ul>
        <h2>From the archive</h2><ul>
          <li><a href="/show/101">Owls at midnight<br><small>Recorded 2024</small></a></li>
          <li><a href="/show/102">Foxes at dawn: Dvořák's Serenade</a></li>
        </ul>`));
      return;
    }
    // Pages with one video each, like a concert page on a subscription site.
    const show = /^\/show\/(\d+)$/.exec(url.pathname);
    if (show) {
      if (!loggedIn) { res.writeHead(302, { location: '/login' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(page(`Show ${show[1]}`, `<h1>Show ${show[1]}</h1>
        <video controls src="/media/clip.mp4?show=${show[1]}"></video>`));
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      if (!loggedIn) { res.writeHead(403).end('members only'); return; }
      // /media/slow/... sends the file at about 150 KB/s, so pausing and stopping can be tested.
      const slow = url.pathname.startsWith('/media/slow/');
      const rel = slow ? url.pathname.slice(12) : url.pathname.slice(7);
      const file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
      const size = fs.statSync(file).size;
      const type = types[path.extname(file)] || 'application/octet-stream';
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
        send(fs.createReadStream(file, { start: a, end: b, highWaterMark: 16384 }), res, slow);
      } else {
        res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
        send(fs.createReadStream(file, { highWaterMark: 16384 }), res, slow);
      }
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function send(stream, res, slow) {
  if (!slow) { stream.pipe(res); return; }
  stream.on('data', (chunk) => {
    stream.pause();
    res.write(chunk);
    setTimeout(() => stream.resume(), 100);
  });
  stream.on('end', () => res.end());
  res.on('close', () => stream.destroy());
}

module.exports = { makeMedia, start };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'browsedl-site'));
  makeMedia(dir);
  start(dir, Number(process.argv[3] || 8777)).then((s) => console.log(`Test site on http://127.0.0.1:${s.address().port}/`));
}
