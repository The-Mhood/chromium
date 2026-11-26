const { contextBridge, ipcRenderer } = require('electron');

const subscribe = channel => callback => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('chromiumCore', {
  platform: process.platform,
  navigate: (id, url) => ipcRenderer.invoke('core:navigate', id, url),
  focusTab: (id, external) => ipcRenderer.invoke('core:focus', id, external),
  closeTab: id => ipcRenderer.invoke('core:close', id),
  tabAction: (id, action) => ipcRenderer.invoke('core:tab-action', id, action),
  setProtection: settings => ipcRenderer.invoke('core:protection', settings),
  setAllowlist: domains => ipcRenderer.invoke('core:allowlist', domains),
  setFilters: filters => ipcRenderer.invoke('core:filters', filters),
  setPrivacy: enabled => ipcRenderer.invoke('core:privacy', enabled),
  getStats: () => ipcRenderer.invoke('core:stats'),
  clearData: () => ipcRenderer.invoke('core:clear-data'),
  windowAction: action => ipcRenderer.send('core:window', action),
  onTabUpdate: subscribe('core:tab-update'),
  onOpenTab: subscribe('core:open-tab'),
  onStats: subscribe('core:stats-update'),
  onChromeVisibility: subscribe('core:chrome-visibility'),
  onFullscreenState: subscribe('core:fullscreen-state'),
});