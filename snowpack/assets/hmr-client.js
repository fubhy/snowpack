/**
 * esm-hmr/runtime.ts
 * A client-side implementation of the ESM-HMR spec, for reference.
 */

function log(...args) {
  console.log('[ESM-HMR]', ...args);
}
function reload() {
  location.reload(true);
}
/** Clear all error overlays from the page */
function clearErrorOverlay() {
  document.querySelectorAll('hmr-error-overlay').forEach((el) => el.remove());
}
/** Create an error overlay (if custom element exists on the page). */
function createNewErrorOverlay(data) {
  const HmrErrorOverlay = customElements.get('hmr-error-overlay');
  if (HmrErrorOverlay) {
    const overlay = new HmrErrorOverlay(data);
    clearErrorOverlay();
    document.body.appendChild(overlay);
  }
}

let SOCKET_MESSAGE_QUEUE = [];
function _sendSocketMessage(msg) {
  socket.send(JSON.stringify(msg));
}
function sendSocketMessage(msg) {
  if (socket.readyState !== socket.OPEN) {
    SOCKET_MESSAGE_QUEUE.push(msg);
  } else {
    _sendSocketMessage(msg);
  }
}
const socketURL =
  (typeof window !== 'undefined' && window.HMR_WEBSOCKET_URL) ||
  (location.protocol === 'http:' ? 'ws://' : 'wss://') + location.host + '/';

const socket = new WebSocket(socketURL, 'esm-hmr');
socket.addEventListener('open', () => {
  SOCKET_MESSAGE_QUEUE.forEach(_sendSocketMessage);
  SOCKET_MESSAGE_QUEUE = [];
});
const REGISTERED_MODULES = {};
class HotModuleState {
  constructor(id) {
    this.data = {};
    this.isLocked = false;
    this.isDeclined = false;
    this.isAccepted = false;
    this.acceptCallbacks = [];
    this.disposeCallbacks = [];
    this.id = id;
  }
  lock() {
    this.isLocked = true;
  }
  dispose(callback) {
    this.disposeCallbacks.push(callback);
  }
  invalidate() {
    reload();
  }
  decline() {
    this.isDeclined = true;
  }
  accept(_deps, callback = true) {
    if (this.isLocked) {
      return;
    }
    if (!this.isAccepted) {
      sendSocketMessage({id: this.id, type: 'hotAccept'});
      this.isAccepted = true;
    }
    if (!Array.isArray(_deps)) {
      callback = _deps || callback;
      _deps = [];
    }
    if (callback === true) {
      callback = () => {};
    }
    const deps = _deps.map((dep) => {
      const ext = dep.split('.').pop();
      if (!ext) {
        dep += '.js';
      } else if (ext !== 'js') {
        dep += '.proxy.js';
      }
      return new URL(dep, `${window.location.origin}${this.id}`).pathname;
    });
    this.acceptCallbacks.push({
      deps,
      callback,
    });
  }
}
export function createHotContext(fullUrl) {
  const id = new URL(fullUrl).pathname;
  const existing = REGISTERED_MODULES[id];
  if (existing) {
    existing.lock();
    runModuleDispose(id);
    return existing;
  }
  const state = new HotModuleState(id);
  REGISTERED_MODULES[id] = state;
  return state;
}

/** Called when a new module is loaded, to pass the updated module to the "active" module */
async function runModuleAccept({url: id, bubbled}) {
  const state = REGISTERED_MODULES[id];
  if (!state) {
    return false;
  }
  if (state.isDeclined) {
    return false;
  }
  const acceptCallbacks = state.acceptCallbacks;
  const updateID = Date.now();
  for (const {deps, callback: acceptCallback} of acceptCallbacks) {
    const [module, ...depModules] = await Promise.all([
      import(id + `?mtime=${updateID}`),
      ...deps.map((d) => import(d + `?mtime=${updateID}`)),
    ]);
    acceptCallback({module, bubbled, deps: depModules});
  }
  return true;
}

/** Called when a new module is loaded, to run cleanup on the old module (if needed) */
async function runModuleDispose(id) {
  const state = REGISTERED_MODULES[id];
  if (!state) {
    return false;
  }
  if (state.isDeclined) {
    return false;
  }
  const disposeCallbacks = state.disposeCallbacks;
  state.disposeCallbacks = [];
  state.data = {};
  disposeCallbacks.map((callback) => callback());
  return true;
}
socket.addEventListener('message', ({data: _data}) => {
  if (!_data) {
    return;
  }
  const data = JSON.parse(_data);
  if (data.type === 'reload') {
    log('message: reload');
    reload();
    return;
  }
  if (data.type === 'error') {
    console.error(
      `[ESM-HMR] ${data.fileLoc ? data.fileLoc + '\n' : ''}`,
      data.title + '\n' + data.errorMessage,
    );
    createNewErrorOverlay(data);
    return;
  }
  if (data.type === 'update') {
    log('message: update', data);
    runModuleAccept(data)
      .then((ok) => {
        if (ok) {
          clearErrorOverlay();
        } else {
          reload();
        }
      })
      .catch((err) => {
        console.error('[ESM-HMR] Hot Update Error', err);
        // A failed import gives a TypeError, but invalid ESM imports/exports give a SyntaxError.
        // Failed build results already get reported via a better WebSocket update.
        // We only want to report invalid code like a bad import that doesn't exist.
        if (err instanceof SyntaxError) {
          createNewErrorOverlay({
            title: 'Hot Update Error',
            fileLoc: data.url,
            errorMessage: err.message,
            errorStackTrace: err.stack,
          });
        }
      });
    return;
  }
  log('message: unknown', data);
});
log('listening for file changes...');

/** Runtime error reporting: If a runtime error occurs, show it in an overlay. */
window.addEventListener('error', function (event) {
  // Generate an "error location" string
  let fileLoc;
  if (event.filename) {
    fileLoc = event.filename;
    if (event.lineno !== undefined) {
      fileLoc += ` [:${event.lineno}`;
      if (event.colno !== undefined) {
        fileLoc += `:${event.colno}`;
      }
      fileLoc += `]`;
    }
  }
  createNewErrorOverlay({
    title: 'Unhandled Runtime Error',
    fileLoc,
    errorMessage: event.message,
    errorStackTrace: event.error.stack,
  });
});
