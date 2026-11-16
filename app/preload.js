// Preload: the only bridge between the renderer and the main process.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kestrel', {
  state: () => ipcRenderer.invoke('app:state'),

  session: {
    create: (opts) => ipcRenderer.invoke('session:create', opts),
    open: (id) => ipcRenderer.invoke('session:open', id),
    rename: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
    remove: (id) => ipcRenderer.invoke('session:delete', id),
    setModel: (provider, model) => ipcRenderer.invoke('session:model', { provider, model }),
  },

  keys: {
    set: (provider, key) => ipcRenderer.invoke('keys:set', { provider, key }),
    remove: (provider) => ipcRenderer.invoke('keys:remove', provider),
    list: () => ipcRenderer.invoke('app:state').then((s) => s.keys),
  },

  models: {
    list: (provider) => ipcRenderer.invoke('models:list', provider),
  },

  mode: {
    set: (mode) => ipcRenderer.invoke('mode:set', mode),
  },

  turn: {
    send: (text) => ipcRenderer.invoke('turn:send', text),
    abort: () => ipcRenderer.invoke('turn:abort'),
  },

  permission: {
    answer: (id, decision) => ipcRenderer.invoke('permission:answer', { id, decision }),
  },

  on: (channel, handler) => {
    const allowed = ['engine:event', 'permission:request'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
