const { randomUUID: uuid } = require('node:crypto');

// Shared by title-bar close and app/tray quit: neither may skip draft saving.
function createTodoWindowGuard({ window, hideToTray, onQuit, askDiscard, randomUUID = uuid,
  setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout }) {
  let ready = false, allowClose = false, pendingId = null, timer = null, prompting = false, quitting = false;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finish = () => {
    clear(); pendingId = null;
    if (quitting) { allowClose = true; onQuit(); }
    else if (!window.isDestroyed()) {
      if (hideToTray) window.hide();
      else { allowClose = true; window.close(); }
    }
  };
  const ask = async () => {
    if (!pendingId || prompting || window.isDestroyed()) return;
    prompting = true; clear();
    try { if (await askDiscard()) finish(); }
    finally { pendingId = null; prompting = false; quitting = false; }
  };
  const request = () => {
    if (allowClose) return;
    if (!ready || window.webContents.isDestroyed() || window.webContents.isCrashed()) { finish(); return; }
    if (pendingId) return;
    pendingId = randomUUID();
    timer = setTimer(() => { void ask().catch(() => {}); }, 4000);
    window.webContents.send('window:prepareClose', pendingId);
  };
  return {
    setReady(value) { ready = value; },
    onClose(event) { if (allowClose) return; event.preventDefault(); request(); },
    confirm({ requestId, success }) {
      if (pendingId !== requestId || prompting || window.isDestroyed()) return { closed: false };
      if (success) { finish(); return { closed: true }; }
      void ask().catch(() => {}); return { closed: false };
    },
    requestQuit() { quitting = true; request(); },
    onLoading() { ready = false; pendingId = null; clear(); },
    onRendererGone() { const waiting = pendingId !== null; ready = false; pendingId = null; clear(); if (waiting) finish(); },
    dispose() { clear(); pendingId = null; },
  };
}
module.exports = { createTodoWindowGuard };
