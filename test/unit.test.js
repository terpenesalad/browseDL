'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../src/main/detect');
const P = require('../src/main/paths');
const C = require('../src/main/cookies');
const Y = require('../src/main/ytdlp');

test('classifies media responses and ignores stream pieces', () => {
  assert.deepEqual(D.classifyResponse({ url: 'https://cdn.x.com/a/b/show.m3u8?token=1', mime: 'application/vnd.apple.mpegurl', status: 200 }), { kind: 'hls', media: 'unknown', ext: 'm3u8' });
  assert.equal(D.classifyResponse({ url: 'https://cdn.x.com/v/manifest', mime: 'application/dash+xml', status: 200 }).kind, 'dash');
  assert.deepEqual(D.classifyResponse({ url: 'https://x.com/songs/one.mp3', mime: 'audio/mpeg', status: 206 }), { kind: 'file', media: 'audio', ext: 'mp3' });
  assert.equal(D.classifyResponse({ url: 'https://x.com/stream?id=4', mime: 'video/mp4', status: 200 }).media, 'video');
  assert.equal(D.classifyResponse({ url: 'https://x.com/a/seg-12-v1.ts', mime: 'video/mp2t', status: 200 }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/a/chunk_44.m4s', mime: 'video/iso.segment' }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/a/segment12.mp4', mime: 'video/mp4' }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/a/init.mp4', mime: 'video/mp4' }), null);
  assert.equal(D.classifyResponse({ url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?x=1', mime: 'video/mp4' }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/page.html', mime: 'text/html' }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/movie.mp4', mime: 'video/mp4', status: 404 }), null);
  assert.equal(D.classifyResponse({ url: 'https://x.com/pic.png', mime: 'image/png' }), null);
  assert.equal(D.classifyResponse({ url: 'blob:https://x.com/1234', mime: 'video/mp4' }), null);
  // Extension wins when the server sends a generic type.
  assert.equal(D.classifyResponse({ url: 'https://x.com/dl/track.flac', mime: 'application/octet-stream' }).media, 'audio');
});

test('media keys ignore signatures but keep meaningful parameters', () => {
  const a = D.mediaKey('https://Cdn.x.com/v.mp4?id=7&token=abc&expires=1');
  const b = D.mediaKey('https://cdn.x.com/v.mp4?expires=2&token=zzz&id=7');
  const c = D.mediaKey('https://cdn.x.com/v.mp4?id=8&token=abc');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('reads sizes from content-range and content-length', () => {
  assert.equal(D.sizeFromHeaders({ 'Content-Range': ['bytes 0-1/12345'] }, 206), 12345);
  assert.equal(D.sizeFromHeaders({ 'content-length': ['999'] }, 200), 999);
  assert.equal(D.sizeFromHeaders({ 'content-length': ['999'] }, 206), null);
});

test('parses HLS master and media playlists', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    'https://other.cdn/1080/index.m3u8',
  ].join('\n');
  const m = D.parseM3u8(master, 'https://x.com/show/master.m3u8');
  assert.equal(m.master, true);
  assert.deepEqual(m.variants.map((v) => v.url), ['https://x.com/show/360/index.m3u8', 'https://other.cdn/1080/index.m3u8']);
  assert.deepEqual(m.variants.map((v) => v.height), [360, 1080]);
  assert.deepEqual(m.audioRenditions, ['https://x.com/show/audio/en.m3u8']);
  assert.equal(m.drm, false);

  const media = D.parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,\na.ts\n#EXTINF:3.5,\nb.ts\n#EXT-X-ENDLIST', 'https://x.com/a.m3u8');
  assert.equal(media.master, false);
  assert.equal(media.duration, 8);
  assert.equal(media.drm, false, 'plain AES-128 is not DRM; yt-dlp can decrypt it');

  const drm = D.parseM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts', 'https://x.com/a.m3u8');
  assert.equal(drm.drm, true);

  const audioOnly = D.parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8', 'https://x.com/m.m3u8');
  assert.equal(audioOnly.audioOnlyStream, true);
});

test('parses DASH manifests', () => {
  const mpd = '<MPD mediaPresentationDuration="PT1H2M3.5S"><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></MPD>';
  const r = D.parseMpd(mpd);
  assert.equal(r.duration, 3724);
  assert.equal(r.drm, true);
  assert.equal(r.media, 'video');
  assert.equal(D.parseMpd('<MPD><AdaptationSet contentType="audio"></AdaptationSet></MPD>').drm, false);
});

test('links and names', () => {
  assert.equal(D.classifyLink('https://x.com/files/Episode%2012.mp3').media, 'audio');
  assert.equal(D.classifyLink('https://x.com/watch?v=1'), null);
  assert.equal(D.nameFromUrl('https://x.com/files/Episode%2012_final.mp3?dl=1'), 'Episode 12 final');
});

test('safe file names on every system', () => {
  assert.equal(P.safeName('AC/DC: Live? <2024> *best*'), 'AC⁄DC꞉ Live？ ‹2024› ＊best＊');
  assert.equal(P.safeName('  trailing dots... '), 'trailing dots');
  assert.equal(P.safeName('CON'), 'CON_');
  assert.equal(P.safeName(''), 'Untitled');
  assert.equal(Array.from(P.safeName('é'.repeat(300), 'x', 120)).length, 120);
  assert.equal(P.siteName('https://www.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(P.siteName('https://m.soundcloud.com/a'), 'soundcloud.com');
});

test('organises output folders by layout', () => {
  const base = { root: '/dl', media: 'video', site: 'youtube.com', collection: 'My: list' };
  const j = (...p) => path.join(...p);
  assert.equal(P.outputDir({ ...base, layout: 'site-collection' }), j('/dl', 'youtube.com', 'My꞉ list'));
  assert.equal(P.outputDir({ ...base, layout: 'site' }), j('/dl', 'youtube.com'));
  assert.equal(P.outputDir({ ...base, layout: 'collection' }), j('/dl', 'My꞉ list'));
  assert.equal(P.outputDir({ ...base, layout: 'collection', collection: null }), j('/dl', 'youtube.com'));
  assert.equal(P.outputDir({ ...base, layout: 'flat' }), j('/dl'));
  assert.equal(P.outputDir({ ...base, layout: 'site-collection', splitByType: true, media: 'audio' }), j('/dl', 'Audio', 'youtube.com', 'My꞉ list'));
  assert.equal(P.templateLiteral('100% real'), '100%% real');
});

test('writes Netscape cookie files yt-dlp can read', () => {
  const txt = C.toNetscape([
    { name: 'sid', value: 'abc', domain: '.example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, expirationDate: 1900000000.5 },
    { name: 'h', value: '1', domain: 'login.example.com', hostOnly: true, path: '/app', secure: false, session: true },
    { name: 'bad', value: 'a\tb', domain: 'x.com' },
  ]);
  const lines = txt.trim().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.ok(lines.includes('#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1900000000\tsid\tabc'));
  assert.ok(lines.includes('login.example.com\tFALSE\t/app\tFALSE\t0\th\t1'));
  assert.ok(!txt.includes('bad'));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdl-')), 'c.txt');
  C.writeCookieFile(f, []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('reads yt-dlp output lines', () => {
  assert.deepEqual(Y.parseLine('BDL_DL downloading|1024|4096|NA|5000.5|3|NA|NA|137'), {
    type: 'progress', status: 'downloading', downloaded: 1024, total: 4096, speed: 5000.5, eta: 3, fragIndex: null, fragCount: null, formatId: '137',
  });
  assert.equal(Y.parseLine('BDL_DL downloading|10|NA|200.0|NA|NA|1|4|hls-720').total, 200);
  assert.deepEqual(Y.parseLine('BDL_PP started|Merger'), { type: 'pp', status: 'started', postprocessor: 'Merger' });
  assert.equal(Y.parseLine('BDL_FILE /x/y z.mp4').path, '/x/y z.mp4');
  assert.equal(Y.parseLine('BDL_META {"title": "T", "format_id": "137+140"}').meta.format_id, '137+140');
  assert.equal(Y.parseLine('ERROR: [generic] Unsupported URL: x').type, 'error');
  assert.equal(Y.parseLine('[download] whatever'), null);
});

test('progress across separate picture and sound downloads', () => {
  const t = new Y.ProgressTracker();
  t.setFormat('137+140');
  assert.equal(t.update({ status: 'downloading', downloaded: 50, total: 100, formatId: '137' }), 0.25);
  assert.equal(t.update({ status: 'finished', downloaded: 100, total: 100, formatId: '137' }), 0.5);
  assert.equal(t.update({ status: 'downloading', downloaded: 50, total: 100, formatId: '140' }), 0.75);
  const h = new Y.ProgressTracker();
  assert.equal(h.update({ status: 'downloading', fragIndex: 3, fragCount: 4, downloaded: 10, total: null }), 0.75);
});

test('builds download commands', () => {
  const a = Y.downloadArgs({
    url: 'https://x.com/v.m3u8', format: 'mp3', homeDir: '/dl', tempDir: '/tmp/p', outName: 'Name', cookieFile: '/c.txt',
    userAgent: 'UA', headers: { Referer: 'https://x.com/page', 'Bad Header': 'x', Origin: 'a\nb' }, ffmpegDir: '/bin', isDirect: true,
  });
  const has = (...xs) => a.some((_, start) => xs.every((x, i) => a[start + i] === x));
  assert.ok(has('-P', 'home:/dl'));
  assert.ok(has('-P', 'temp:/tmp/p'));
  assert.ok(has('-o', 'Name.%(ext)s'));
  assert.ok(has('--cookies', '/c.txt'));
  assert.ok(has('--add-header', 'Referer:https://x.com/page'));
  assert.ok(has('--audio-format', 'mp3'));
  assert.ok(a.includes('--force-generic-extractor'));
  assert.ok(!a.some((x) => x.includes('Bad Header') || x.includes('a\nb')));
  assert.deepEqual(a.slice(-2), ['--', 'https://x.com/v.m3u8']);
  const b = Y.downloadArgs({ url: 'https://youtube.com/watch?v=1', format: '720', homeDir: '/d', tempDir: '/t', outName: 'x', cookiesFromBrowser: 'firefox' });
  assert.ok(b.includes('res:720,vcodec:h264,acodec:m4a'));
  assert.ok(b.includes('--cookies-from-browser') && !b.includes('--cookies'));
  assert.ok(!b.includes('--force-generic-extractor'));
});

test('turns scan results into queueable entries', () => {
  const r = Y.scanResultToEntries({
    _type: 'playlist', title: 'Mix', extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/playlist?list=1',
    entries: [
      { url: 'https://www.youtube.com/watch?v=a', id: 'a', title: 'A', duration: 61, ie_key: 'Youtube', thumbnails: [{ url: 'https://i/1.jpg' }] },
      { url: 'https://www.youtube.com/@x/videos', title: 'X - Videos', ie_key: 'YoutubeTab', _type: 'url' },
      null,
    ],
  });
  assert.equal(r.title, 'Mix');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].thumbnail, 'https://i/1.jpg');
  assert.equal(r.entries[0].isList, false);
  assert.equal(r.entries[1].isList, true);
  const single = Y.scanResultToEntries({ id: 'v', title: 'One', webpage_url: 'https://v.com/1', extractor_key: 'Vimeo', duration: 5 });
  assert.equal(single.entries.length, 1);
  assert.equal(single.extractor, 'Vimeo');
});

test('explains errors in plain words', () => {
  assert.match(Y.friendlyError('HTTP Error 403: Forbidden'), /refused/);
  assert.match(Y.friendlyError('This video is DRM protected'), /DRM/);
  assert.match(Y.friendlyError('Sign in to confirm your age'), /logged in/);
  assert.match(Y.friendlyError('Unsupported URL: https://x'), /No media/);
});

test('picks a free file name', () => {
  const { uniqueBase } = require('../src/main/queue');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdl-'));
  fs.writeFileSync(path.join(dir, 'Song.mp3'), '');
  fs.writeFileSync(path.join(dir, 'Song (2).m4a'), '');
  assert.equal(uniqueBase(dir, 'Other', { id: 'x' }), 'Other');
  assert.equal(uniqueBase(dir, 'song', { id: 'x' }), 'song (3)');
  assert.equal(uniqueBase(dir, 'Other', { id: 'x' }, new Set([path.join(dir, 'other').toLowerCase()])), 'Other (2)');
});

test('finds the saved file even when the printed path is garbled', () => {
  const { locateSaved } = require('../src/main/queue');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdl-'));
  const real = path.join(dir, 'Emmanuelle Haïm conducts Handel – “Live” [abc123].mp4');
  fs.writeFileSync(real, 'x');
  fs.writeFileSync(path.join(dir, 'Other [zzz].mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'Partial [p].mp4.part'), 'x');
  const garbled = path.join(dir, 'Emmanuelle HaÃ¯m conducts Handel â€“ â€œLiveâ€\x9d [abc123].mp4');
  const pathFile = path.join(dir, 'saved.txt');
  // 1. The UTF-8 path file wins.
  fs.writeFileSync(pathFile, real + '\n', 'utf8');
  assert.equal(locateSaved({ pathFile, printed: garbled, homeDir: dir, startedAt: 0 }), real);
  // 2. No path file: the video's [id] finds it.
  fs.unlinkSync(pathFile);
  assert.equal(locateSaved({ pathFile, printed: garbled, homeDir: dir, startedAt: 0, videoId: 'abc123' }), real);
  // 3. Direct downloads are found by the name browseDL chose.
  const named = path.join(dir, 'Theme – “tune”.mp3');
  fs.writeFileSync(named, 'x');
  assert.equal(locateSaved({ pathFile, printed: garbled, homeDir: dir, startedAt: 0, base: 'Theme – “tune”' }), named);
  // 4. Otherwise only an unambiguous new file counts.
  assert.equal(locateSaved({ pathFile, printed: garbled, homeDir: dir, startedAt: 0 }), null);
  assert.equal(locateSaved({ pathFile, printed: garbled, homeDir: path.join(dir, 'nope'), startedAt: 0 }), null);
});
