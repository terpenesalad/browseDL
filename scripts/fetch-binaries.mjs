// Download yt-dlp, ffmpeg and deno for bundling into browseDL.
// (yt-dlp works without ffprobe, so it's left out to keep the app ~175 MB smaller.)
//
// Usage:  node scripts/fetch-binaries.mjs [platform-arch]     (default: this computer, e.g. win32-x64)
// Output: vendor/bin/<platform-arch>/
//
// Windows and Linux use yt-dlp's own patched ffmpeg builds; macOS uses Martin Riedl's signed static builds.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const [platform, arch] = target.split('-');
const exe = platform === 'win32' ? '.exe' : '';
const dest = path.join(ROOT, 'vendor', 'bin', target);

const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFB = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/';
const DENO = 'https://github.com/denoland/deno/releases/latest/download/';
const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/';

const SOURCES = {
  'win32-x64': {
    ytdlp: YTDLP + 'yt-dlp.exe',
    ffmpeg: { archive: FFB + 'ffmpeg-master-latest-win64-gpl.zip' },
    deno: DENO + 'deno-x86_64-pc-windows-msvc.zip',
  },
  'linux-x64': {
    ytdlp: YTDLP + 'yt-dlp_linux',
    ffmpeg: { archive: FFB + 'ffmpeg-master-latest-linux64-gpl.tar.xz' },
    deno: DENO + 'deno-x86_64-unknown-linux-gnu.zip',
  },
  'linux-arm64': {
    ytdlp: YTDLP + 'yt-dlp_linux_aarch64',
    ffmpeg: { archive: FFB + 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' },
    deno: DENO + 'deno-aarch64-unknown-linux-gnu.zip',
  },
  'darwin-arm64': {
    ytdlp: YTDLP + 'yt-dlp_macos',
    ffmpeg: { zip: RIEDL + 'arm64/release/ffmpeg.zip' },
    deno: DENO + 'deno-aarch64-apple-darwin.zip',
  },
  'darwin-x64': {
    ytdlp: YTDLP + 'yt-dlp_macos',
    ffmpeg: { zip: RIEDL + 'amd64/release/ffmpeg.zip' },
    deno: DENO + 'deno-x86_64-apple-darwin.zip',
  },
};

const src = SOURCES[target];
if (!src) {
  console.error(`No binaries known for ${target}. Known: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(1);
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Downloading ${url}`);
      const res = await fetch(url, { headers: { 'User-Agent': 'browseDL-build' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (err) {
      if (attempt >= 4) throw new Error(`Couldn't download ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  if (archive.endsWith('.zip') && process.platform === 'linux') execFileSync('unzip', ['-q', '-o', archive, '-d', into]);
  else execFileSync('tar', ['-xf', archive, '-C', into]);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function place(from, name) {
  const to = path.join(dest, name + exe);
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
  console.log(`  -> ${path.relative(ROOT, to)} (${(fs.statSync(to).size / 1e6).toFixed(1)} MB)`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'browsedl-bins-'));
try {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  place(await download(src.ytdlp, path.join(work, 'yt-dlp' + exe)), 'yt-dlp');

  const ffUrl = src.ffmpeg.archive || src.ffmpeg.zip;
  const a = await download(ffUrl, path.join(work, path.basename(new URL(ffUrl).pathname)));
  extract(a, path.join(work, 'ffmpeg'));
  place(findFile(path.join(work, 'ffmpeg'), 'ffmpeg' + exe), 'ffmpeg');

  const d = await download(src.deno, path.join(work, 'deno.zip'));
  extract(d, path.join(work, 'deno'));
  place(findFile(path.join(work, 'deno'), 'deno' + exe), 'deno');

  if (platform === 'darwin') {
    // Downloaded binaries carry a quarantine flag on some setups; clear it so the app can run them.
    try { execFileSync('xattr', ['-cr', dest]); } catch { /* not quarantined */ }
  }
  console.log(`Binaries for ${target} are in ${path.relative(ROOT, dest)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
