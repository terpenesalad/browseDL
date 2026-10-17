'use strict';
// Everything browseDL has downloaded, so it can be browsed, re-filed and not downloaded twice.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { outputDir, safeName } = require('./paths');
const { uniqueBase } = require('./queue');

class Library extends EventEmitter {
  /**
   * @param {import('./store').JsonStore} store
   * @param {() => object} settings
   */
  constructor(store, settings) {
    super();
    this.store = store;
    this.settings = settings;
    this.items = store.data || [];
    this._index();
  }

  _index() {
    this.keys = new Set();
    for (const r of this.items) for (const k of r.keys || []) this.keys.add(k);
  }

  list() {
    return this.items.map((r) => ({ ...r, keys: undefined, missing: !fileExists(r.file) }));
  }

  has(keys) {
    return (keys || []).some((k) => this.keys.has(k));
  }

  /** Which of these key lists are already in the library (for marking items in the catch panel). */
  hasMany(keyLists) {
    return keyLists.map((keys) => this.has(keys));
  }

  add(rec) {
    // Re-downloading the same file replaces its old record.
    this.items = this.items.filter((r) => r.file !== rec.file);
    const r = { id: crypto.randomUUID(), addedAt: Date.now(), ...rec };
    this.items.unshift(r);
    for (const k of r.keys || []) this.keys.add(k);
    this._save();
    return r;
  }

  /**
   * @param {string[]} ids
   * @param {{trash?: (file:string)=>Promise<void>}} opts  trash: also move the files to the bin
   */
  async remove(ids, opts = {}) {
    const gone = this.items.filter((r) => ids.includes(r.id));
    const failed = [];
    if (opts.trash) {
      for (const r of gone) {
        if (!fileExists(r.file)) continue;
        try { await opts.trash(r.file); } catch { failed.push(r.title); }
      }
      for (const r of gone) pruneEmpty(path.dirname(r.file), this.settings().downloadDir);
    }
    this.items = this.items.filter((r) => !ids.includes(r.id));
    this._index();
    this._save();
    return { removed: gone.length, failed };
  }

  /** Move items into another collection folder (or out of collections with an empty name). */
  move(ids, collection) {
    const s = this.settings();
    const coll = collection ? safeName(collection, 'Unsorted', 100) : null;
    let moved = 0;
    const errors = [];
    for (const r of this.items) {
      if (!ids.includes(r.id)) continue;
      const dir = outputDir({ root: s.downloadDir, layout: s.layout, splitByType: s.splitByType, media: r.media, site: r.site, collection: coll });
      if (!fileExists(r.file)) {
        r.collection = coll;
        continue;
      }
      if (path.resolve(path.dirname(r.file)).toLowerCase() === path.resolve(dir).toLowerCase()) {
        r.collection = coll;
        continue;
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        const ext = path.extname(r.file);
        const base = uniqueBase(dir, path.basename(r.file, ext), r);
        const dest = path.join(dir, base + ext);
        moveFile(r.file, dest);
        pruneEmpty(path.dirname(r.file), s.downloadDir);
        r.file = dest;
        r.collection = coll;
        moved++;
      } catch (err) {
        errors.push(`${r.title}: ${err.message}`);
      }
    }
    this._save();
    return { moved, errors };
  }

  rename(id, title) {
    const r = this.items.find((x) => x.id === id);
    if (!r || !title) return { ok: false };
    const ext = path.extname(r.file);
    const dir = path.dirname(r.file);
    const want = safeName(title, r.title, 150);
    if (fileExists(r.file) && want !== path.basename(r.file, ext)) {
      const base = uniqueBase(dir, want, r);
      const dest = path.join(dir, base + ext);
      moveFile(r.file, dest);
      r.file = dest;
    }
    r.title = title;
    this._save();
    return { ok: true };
  }

  forgetMissing() {
    const before = this.items.length;
    this.items = this.items.filter((r) => fileExists(r.file));
    this._index();
    this._save();
    return before - this.items.length;
  }

  _save() {
    this.store.data = this.items;
    this.store.save();
    this.emit('changed');
  }
}

function fileExists(f) {
  try { return !!f && fs.statSync(f).isFile(); } catch { return false; }
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/** Remove folders left empty by a move or delete, without going above the download folder. */
function pruneEmpty(dir, root) {
  const stop = path.resolve(root || '/');
  let d = path.resolve(dir);
  while (d.startsWith(stop) && d !== stop) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

module.exports = { Library, fileExists, pruneEmpty };
