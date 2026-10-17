'use strict';
// Finding the bundled yt-dlp, ffmpeg and deno, and keeping yt-dlp up to date.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

class Bins {
  /**
   * @param {{resourcesDir:string, devDir:string, userDir:string, packaged:boolean}} o
   */
  constructor(o) {
    this.bundledDir = o.packaged ? path.join(o.resourcesDir, 'bin') : path.join(o.devDir, 'vendor', 'bin', `${process.platform}-${process.arch}`);
    this.userDir = path.join(o.userDir, 'bin');
    this.ready = null;
  }

  bundled(name) {
    const p = path.join(this.bundledDir, name + EXE);
    return fs.existsSync(p) ? p : null;
  }

  /** ffmpeg and deno are used straight from the bundle (or the system PATH when running from source). */
  get ffmpegDir() {
    return this.bundled('ffmpeg') ? this.bundledDir : null;
  }

  /** The PATH for yt-dlp, so it finds deno and ffmpeg. */
  env() {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (fs.existsSync(this.bundledDir)) env.PATH = this.bundledDir + path.delimiter + (env.PATH || env.Path || '');
    if (process.platform === 'win32' && env.Path) env.Path = env.PATH;
    return env;
  }

  /**
   * yt-dlp lives in the user's data folder so it can update itself.
   * On first run, or when the app ships a newer one, it's copied from the bundle.
   */
  async ytdlp() {
    if (!this.ready) this.ready = this._prepareYtdlp();
    return this.ready;
  }

  async _prepareYtdlp() {
    const src = this.bundled('yt-dlp');
    if (!src) return 'yt-dlp'; // running from source without fetched binaries: use the system one
    const dst = path.join(this.userDir, 'yt-dlp' + EXE);
    try {
      fs.mkdirSync(this.userDir, { recursive: true });
      let copy = !fs.existsSync(dst);
      if (!copy) {
        const [a, b] = await Promise.all([version(src), version(dst)]);
        copy = !b || (a && a > b);
      }
      if (copy) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
      }
      return dst;
    } catch (err) {
      console.error('Using bundled yt-dlp directly:', err);
      return src;
    }
  }

  async versions() {
    const y = await this.ytdlp();
    return {
      ytdlp: await version(y),
      ffmpeg: this.bundled('ffmpeg') ? 'bundled' : 'system',
      deno: this.bundled('deno') ? 'bundled' : 'system',
    };
  }

  /** Update the user's copy of yt-dlp to the newest release. */
  async update() {
    const y = await this.ytdlp();
    return new Promise((resolve) => {
      execFile(y, ['-U'], { env: this.env(), timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        resolve({ ok: !err, output: out.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') });
      });
    });
  }
}

function version(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 60000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split(/\s+/)[0] || null);
    });
  });
}

module.exports = { Bins, version, EXE };
