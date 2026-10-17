'use strict';
// The narrow bridge between browseDL's interface and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state', 'versions',
  'tab:new', 'tab:close', 'tab:activate', 'tab:navigate', 'tab:go', 'tab:media', 'tab:rescan', 'browser:bounds', 'scan:list',
  'queue:add', 'queue:action', 'queue:addLinks',
  'library:open', 'library:reveal', 'library:remove', 'library:move', 'library:rename', 'library:forgetMissing', 'library:openPage',
  'settings:set', 'settings:chooseFolder',
  'app:openFolder', 'app:updateYtdlp', 'app:clearBrowsing', 'app:openExternal',
]);
const EVENTS = new Set(['tabs', 'media', 'queue', 'queue:items', 'library', 'settings', 'toast', 'focus-address', 'show-view', 'open-catch']);

contextBridge.exposeInMainWorld('bdl', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
