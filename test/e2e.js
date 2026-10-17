'use strict';
// End-to-end: log in to the test site in browseDL's browser, catch everything on the members page,
// download it all, and check it's filed and listed. Run with: xvfb-run -a node test/e2e.js
// (needs `npm run fetch-binaries` or yt-dlp/ffmpeg/deno on PATH). Set SHOTS=dir to save screenshots.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');
const site = require('./site/server');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last})`);
}

function screen(name) {
  // Grab the whole X display so the web page (a separate view) is in the picture too.
  if (!SHOTS || !process.env.DISPLAY) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', process.env.SHOT_SIZE || '1440x900', '-i', process.env.DISPLAY, '-frames:v', '1', path.join(SHOTS, `${name}.png`)]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browsedl-e2e-'));
  const media = path.join(tmp, 'site');
  const downloads = path.join(tmp, 'downloads');
  const userData = path.join(tmp, 'data');
  site.makeMedia(media);
  const server = await site.start(media);
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(userData, { recursive: true });
  const elsewhere = path.join(tmp, 'Elsewhere – “chosen”');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ downloadDir: downloads, homePage: `${base}/`, concurrency: 3, minSizeKB: 0 }));

  const app = await electron.launch({
    cwd: ROOT,
    args: ['.', '--no-sandbox'],
    env: { ...process.env, BROWSEDL_USER_DATA: userData, BROWSEDL_TEST_GENERIC_LINKS: '1' },
  });
  let ok = false;
  try {
    await app.firstWindow();
    const win = await waitFor(() => app.windows().find((w) => w.url().endsWith('/renderer/index.html')), 'the browseDL window');
    await win.waitForSelector('#address');
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    });

    // 1. The members page is locked until we log in.
    await win.fill('#address', `${base}/members`);
    await win.press('#address', 'Enter');
    await waitFor(async () => (await win.inputValue('#address')).endsWith('/login'), 'redirect to the login page');

    // 2. Log in (the test site's quick-login link sets the session cookie), landing on the members page.
    await win.fill('#address', `${base}/login?auto=1`);
    await win.press('#address', 'Enter');
    await waitFor(async () => (await win.inputValue('#address')).endsWith('/members'), 'the members page');

    // 3. The catch panel lists the playing video, the audio player, two linked episodes and the stream.
    const titles = await waitFor(async () => {
      const t = await win.$$eval('#catch-list .pick .title', (els) => els.map((e) => e.textContent));
      return t.length >= 5 && t.some((x) => /Owls/.test(x)) && t.some((x) => /Foxes/.test(x)) ? t : null;
    }, 'caught media');
    console.log('Caught:', titles);
    assert.ok(titles.some((t) => /Theme tune/.test(t)), 'audio element listed by its title');
    assert.ok(titles.some((t) => /Live archive/.test(t)), 'HLS link listed');
    const count = Number(await win.textContent('#catch-count'));
    assert.ok(count >= 5, `found counter shows ${count}`);
    assert.equal(await win.inputValue('#catch-folder'), 'Night Radio – Members');
    await waitFor(async () => await win.$('#catch-list .scanning'), 'the yt-dlp page check to start', 10000).catch(() => {});
    await waitFor(async () => !(await win.$('#catch-list .scanning')), 'the yt-dlp page check to finish', 60000);
    await sleep(500);
    screen('browse');

    // 4. Download them all as they are.
    const goText = await win.textContent('#catch-go');
    assert.match(goText, /Download \d+/);
    const n = Number(goText.match(/\d+/)[0]);
    await win.click('#catch-go');
    await waitFor(async () => /Added/.test(await win.textContent('#st-msg')), 'queued toast');

    // 5. They all finish.
    await win.click('.nav[data-view="queue"]');
    await waitFor(async () => (await win.$$('.qrow.done')).length === n, `${n} finished downloads`, 120000);
    const failed = await win.$$eval('.qrow.failed .err', (els) => els.map((e) => e.textContent));
    assert.deepEqual(failed, []);
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'queue.png') });

    // 6. Files are filed under site / collection, and they're real media.
    const folder = path.join(downloads, '127.0.0.1', 'Night Radio – Members');
    const files = fs.readdirSync(folder).sort();
    console.log('Files:', files);
    assert.equal(files.length, n);
    assert.ok(files.includes('Episode 1꞉ Owls.mp3'), 'episode named from its link text');
    assert.ok(files.some((f) => f.endsWith('.mp4')), 'video saved');
    for (const f of files) assert.ok(fs.statSync(path.join(folder, f)).size > 10000, `${f} has content`);

    // 7. The library lists them; move one into another folder.
    await win.click('.nav[data-view="library"]');
    await waitFor(async () => (await win.$$('.lrow')).length === n, 'library rows');
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'library.png') });
    await win.locator('.lrow', { hasText: 'Episode 2: Foxes' }).locator('input[type=checkbox]').click();
    await win.waitForSelector('#lib-selbar:not([hidden])');
    await win.click('#lib-sel-move');
    await win.fill('#dlg-input', 'Favourites');
    await win.click('#dlg-ok');
    await waitFor(() => fs.existsSync(path.join(downloads, '127.0.0.1', 'Favourites', 'Episode 2꞉ Foxes.mp3')), 'moved file');
    assert.ok(!fs.existsSync(path.join(folder, 'Episode 2꞉ Foxes.mp3')));

    // 8. Back on the page, everything is marked as downloaded and nothing is ticked.
    await win.click('.nav[data-view="browse"]');
    await waitFor(async () => (await win.$$('#catch-list .tag.done')).length >= n, 'downloaded tags');
    assert.equal(await win.textContent('#catch-go'), 'Download');

    // 9. Pasting a direct link uses the browser's login too, and the library stops duplicates.
    await win.click('.nav[data-view="queue"]');
    await win.click('#q-addlinks-toggle');
    await win.fill('#addlinks-text', `${base}/media/ep1.mp3\n${base}/media/clip.mp4?copy=2`);
    await win.click('#addlinks-go');
    await waitFor(async () => /Added 1/.test(await win.textContent('#st-msg')), 'add-links toast', 60000);
    console.log('Add links:', await win.textContent('#st-msg'));
    await waitFor(async () => (await win.$$('.qrow.done')).length === n + 1, 'pasted link downloaded', 60000);

    // 10. Pause keeps the partial file and resume finishes it; Stop all cancels and cleans up.
    if (await win.isHidden('#addlinks')) await win.click('#q-addlinks-toggle');
    await win.fill('#addlinks-text', `${base}/media/slow/big.mp4`);
    await win.click('#addlinks-go');
    const slowRow = win.locator('.qrow', { hasText: 'big' });
    await waitFor(async () => /\d+%/.test(await slowRow.locator('.state').textContent().catch(() => '')), 'slow download progress');
    await slowRow.locator('[data-act="pause"]').click();
    await waitFor(async () => /Paused/.test(await slowRow.locator('.state').textContent()), 'paused');
    const partsDir = path.join(userData, 'work', 'parts');
    const parts = () => (fs.existsSync(partsDir) ? fs.readdirSync(partsDir).flatMap((d) => fs.readdirSync(path.join(partsDir, d))) : []);
    await sleep(800);
    assert.ok(parts().some((f) => f.endsWith('.part')), `partial file kept while paused (${parts()})`);
    await slowRow.locator('[data-act="resume"]').click();
    await waitFor(async () => (await slowRow.getAttribute('class')).includes('done'), 'resumed download finished', 120000);
    assert.ok(fs.existsSync(path.join(downloads, '127.0.0.1', 'big [big].mp4')), 'resumed file saved');

    if (await win.isHidden('#addlinks')) await win.click('#q-addlinks-toggle');
    await win.fill('#addlinks-text', `${base}/media/slow/big2.mp4`);
    await win.click('#addlinks-go');
    await waitFor(async () => (await win.$$('.qrow.running')).length === 1, 'second slow download running');
    await sleep(1000);
    console.log('Before stop:', await win.$$eval('.qrow', (els) => els.map((e) => `${e.className} ${e.querySelector('.state').textContent} ${e.querySelector('.err') ? e.querySelector('.err').textContent : ''}`)));
    await win.click('#st-stop');
    await waitFor(async () => (await win.$$('.qrow.stopped')).length === 1, 'stopped');
    await sleep(1500);
    assert.deepEqual(parts(), [], 'partial files removed after stopping');
    const procs = execFileSync('ps', ['-eo', 'args']).toString().split('\n').filter((l) => /yt-dlp/.test(l) && /big2\.mp4/.test(l));
    assert.deepEqual(procs, [], 'no yt-dlp left running');
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'queue2.png') });

    // 11. Linked pages: the archive's show pages are listed (unticked), and go to a folder chosen for this batch.
    await win.click('.nav[data-view="browse"]');
    await waitFor(async () => /Linked show pages \(2\)/.test(await win.textContent('#catch-list')), 'linked show pages', 60000);
    const linkedTitles = await win.$$eval('#catch-list .pick .title', (els) => els.map((e) => e.textContent));
    assert.ok(linkedTitles.includes('Owls at midnight'), `linked titles: ${linkedTitles}`);
    assert.match(await win.textContent('#catch-list'), /Recorded 2024/, 'the rest of the card shows as detail');
    assert.equal(await win.textContent('#catch-go'), 'Download', 'linked pages start unticked');
    // The filter narrows the list (accents don't matter), and Tick all only ticks what's shown.
    await win.fill('#catch-filter', 'dvorak serenade');
    await waitFor(async () => /Linked show pages \(1 of 2\)/.test(await win.textContent('#catch-list')), 'filtered to one linked page');
    assert.deepEqual(await win.$$eval('#catch-list .pick .title', (els) => els.map((e) => e.textContent)), ["Foxes at dawn: Dvořák's Serenade"]);
    await win.locator('.group', { hasText: 'Linked show pages' }).locator('[data-all]').click();
    assert.equal(await win.textContent('#catch-go'), 'Download 1');
    await win.fill('#catch-filter', 'OWLS');
    await waitFor(async () => !(await win.isHidden('#catch-hidden')), 'note about ticked items hidden by the filter');
    assert.match(await win.textContent('#catch-hidden'), /1 ticked item is hidden/);
    if (SHOTS) screen('filter');
    await win.locator('.group', { hasText: 'Linked show pages' }).locator('[data-all]').click();
    assert.equal(await win.textContent('#catch-go'), 'Download 2', 'ticks from both searches add up');
    await win.fill('#catch-filter', 'nothing like this');
    await waitFor(async () => /Nothing matches/.test(await win.textContent('#catch-list')), 'no-match message');
    await win.press('#catch-filter', 'Escape');
    assert.equal(await win.inputValue('#catch-filter'), '');
    // Pick the folder through "Choose a folder…", answering the system folder dialog for the test.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, elsewhere);
    await win.selectOption('#catch-dir', { label: 'Choose a folder…' });
    await waitFor(async () => (await win.$eval('#catch-dir', (el) => el.value)) === elsewhere, 'the chosen folder selected');
    assert.ok(await win.$eval('#addlinks-dir', (el) => [...el.options].some((o) => o.value === el.ownerDocument.querySelector('#catch-dir').value)), 'chosen folder offered in Add links too');
    if (SHOTS) screen('linked');
    await win.click('#catch-go');
    await win.click('.nav[data-view="queue"]');
    const savedElsewhere = () => {
      const found = [];
      const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mp4')) found.push(path.relative(elsewhere, p)); } };
      walk(elsewhere);
      return found;
    };
    await waitFor(() => savedElsewhere().length === 2, 'two show videos in the chosen folder', 120000);
    console.log('Saved in chosen folder:', savedElsewhere());
    assert.ok(savedElsewhere().every((f) => f.startsWith(path.join('127.0.0.1', 'Night Radio – Members'))), 'organised inside the chosen folder');

    ok = true;
    console.log('E2E passed');
  } finally {
    await app.close().catch(() => {});
    server.close();
    if (ok) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log('Left test files in', tmp);
  }
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
