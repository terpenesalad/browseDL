'use strict';
// `browseDL --self-test`: proves the bundled yt-dlp, ffmpeg and deno work together.
// Serves generated test media from a local server (some of it behind a login cookie) and runs
// it through the real download queue. Release builds run this before they're published.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { JsonStore } = require('./store');
const { Queue } = require('./queue');
const { Library } = require('./library');
const { EXE } = require('./bins');

function exec(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} ${args[0]}: ${err.message}\n${stderr}`));
      else resolve(String(stdout));
    });
  });
}

function serve(root) {
  const types = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/private/')) {
      if (!/(^|;\s*)session=letmein/.test(req.headers.cookie || '')) {
        res.writeHead(403).end('log in first');
        return;
      }
      p = p.slice('/private'.length);
    }
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Which kinds of stream (video, audio) a file has, read from `ffmpeg -i`. */
function streamTypes(ffmpeg, file) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true }, (_err, _out, stderr) => {
      const types = new Set();
      for (const m of String(stderr).matchAll(/Stream #\d+:\d+[^:]*: (Video|Audio):/g)) {
        // Cover art in an MP3 shows up as a one-frame video stream; it isn't picture content.
        if (m[1] === 'Video' && /attached pic/.test(String(stderr).slice(m.index, String(stderr).indexOf('\n', m.index)))) continue;
        types.add(m[1].toLowerCase());
      }
      resolve(types);
    });
  });
}

async function selfTest({ bins }) {
  // Windows GUI apps have no console, so CI also asks for the log in a file.
  const logFile = process.env.BROWSEDL_SELFTEST_LOG;
  const log = (...a) => {
    const line = a.join(' ') + '\n';
    try { process.stdout.write(line); } catch { /* no console */ }
    if (logFile) fs.appendFileSync(logFile, line);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browsedl-selftest-'));
  const site = path.join(tmp, 'site');
  const out = path.join(tmp, 'downloads');
  fs.mkdirSync(site, { recursive: true });
  let server = null;
  try {
    const ffmpeg = bins.bundled('ffmpeg') || 'ffmpeg';
    const deno = bins.bundled('deno') || 'deno';
    const ytdlp = await bins.ytdlp();
    log('yt-dlp ', (await exec(ytdlp, ['--version'], { env: bins.env() })).trim());
    log('ffmpeg ', (await exec(ffmpeg, ['-version'])).split('\n')[0]);
    log('deno   ', (await exec(deno, ['--version'])).split('\n')[0]);

    // Test media: a normal MP4, an HLS stream, and DASH with separate picture and sound (which must be joined).
    const src = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
    const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'];
    await exec(ffmpeg, ['-loglevel', 'error', '-y', ...src, ...enc, path.join(site, 'clip.mp4')]);
    fs.mkdirSync(path.join(site, 'hls'));
    await exec(ffmpeg, ['-loglevel', 'error', '-y', '-i', path.join(site, 'clip.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', 'index.m3u8'], { cwd: path.join(site, 'hls') });
    fs.mkdirSync(path.join(site, 'dash'));
    // ffmpeg's DASH writer mishandles Windows paths (pieces land in the working folder), so run it from inside the folder.
    await exec(ffmpeg, ['-loglevel', 'error', '-y', '-i', path.join(site, 'clip.mp4'), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash', '-seg_duration', '1', 'manifest.mpd'], { cwd: path.join(site, 'dash') });

    server = await serve(site);
    const base = `http://127.0.0.1:${server.address().port}`;

    const settings = {
      downloadDir: out, concurrency: 3, format: 'best', layout: 'site-collection', splitByType: false,
      skipDownloaded: true, loginSource: 'browsedl', minSizeKB: 0,
    };
    const work = path.join(tmp, 'work');
    const library = new Library(new JsonStore(path.join(work, 'library.json'), []), () => settings);
    const queue = new Queue({
      store: new JsonStore(path.join(work, 'queue.json'), []),
      settings: () => settings,
      bins,
      library,
      getCookies: async () => [{ name: 'session', value: 'letmein', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, session: true }],
      userAgent: () => 'Mozilla/5.0 browseDL-self-test',
      workDir: work,
    });
    const jobs = [
      { name: 'Logged-in video', url: `${base}/private/clip.mp4`, kind: 'file', media: 'video', format: 'best', expect: { video: true, audio: true } },
      { name: 'Logged-in audio as MP3', url: `${base}/private/clip.mp4?as=mp3`, kind: 'file', media: 'video', format: 'mp3', expect: { video: false, audio: true, ext: '.mp3' } },
      { name: 'HLS stream', url: `${base}/private/hls/index.m3u8`, kind: 'hls', media: 'video', format: 'best', expect: { video: true, audio: true } },
      { name: 'DASH picture and sound joined', url: `${base}/dash/manifest.mpd`, kind: 'dash', media: 'video', format: 'best', expect: { video: true, audio: true } },
    ];
    const r = queue.add(jobs.map((j) => ({ ...j, title: j.name, pageUrl: `${base}/page.html`, collection: 'Self test' })), { force: true });
    if (r.added !== jobs.length) throw new Error(`Only ${r.added} of ${jobs.length} test downloads were queued`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Downloads took too long')), 240000);
      const check = () => {
        if (queue.items.every((i) => i.status === 'done' || i.status === 'failed')) {
          clearTimeout(timer);
          resolve();
        }
      };
      queue.on('list', check);
      queue.on('items', check);
    });

    let ok = true;
    for (const [n, item] of queue.items.entries()) {
      const want = jobs[n].expect;
      if (item.status !== 'done') {
        log('FAIL', jobs[n].name, '-', item.error);
        ok = false;
        continue;
      }
      const types = await streamTypes(ffmpeg, item.file);
      const good = types.has('audio') === want.audio && types.has('video') === want.video && (!want.ext || item.file.endsWith(want.ext));
      log(good ? 'ok  ' : 'FAIL', jobs[n].name, '->', path.relative(out, item.file), `[${[...types].join('+')}]`);
      if (!good) ok = false;
    }
    if (!fs.existsSync(path.join(out, '127.0.0.1', 'Self test'))) {
      log('FAIL files were not organised into site/collection folders');
      ok = false;
    }
    if (library.items.length !== jobs.length) {
      log('FAIL library has', library.items.length, 'items');
      ok = false;
    }
    log(ok ? 'Self-test passed' : 'Self-test FAILED');
    return ok ? 0 : 1;
  } catch (err) {
    log('Self-test FAILED:', err.stack || err.message);
    return 1;
  } finally {
    if (server) server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { selfTest, EXE };
