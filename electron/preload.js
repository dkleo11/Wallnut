'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'app:bootstrap',
  'app:settings:save',
  'app:openExternal',
  'app:openDataDir',
  'app:openProxySettings',
  'app:pickFile',
  'app:theme',
  'app:copyText',
  'sub:add',
  'sub:importText',
  'sub:update',
  'sub:updateAll',
  'sub:remove',
  'sub:toggle',
  'sub:preview',
  'local:importText',
  'local:save',
  'local:remove',
  'local:testText',
  'region:save',
  'region:remove',
  'region:presetAdd',
  'region:applyFastest',
  'rule:save',
  'ruleprovider:save',
  'ruleprovider:remove',
  'ruleprovider:update',
  'group:save',
  'core:start',
  'core:stop',
  'core:restart',
  'core:apply',
  'core:validate',
  'core:logs',
  'core:configPreview',
  'core:meta',
  'test:start',
  'test:cancel',
  'test:last',
  'test:one',
  'net:systemProxy',
  'net:tun',
  'net:status',
  'dns:flush',
  'conn:closeAll',
  'ctl:rest',
  'app:showWindow',
  'app:quit',
  'app:autostart',
  'app:autostartStatus',
  'app:notifyTest',
  'app:openTaskbarSettings',
  'app:trayReinit',
  'rewrite:save',
  'rewrite:remove',
  'rewrite:start',
  'rewrite:stop',
  'rewrite:status',
  'rewrite:caStatus',
  'rewrite:caGenerate',
  'rewrite:caInstall',
  'rewrite:caUninstall',
  'rewrite:caExport',
  'mitm:saveHosts'
];

const EVENTS = ['state', 'core', 'log', 'test', 'toast', 'navigate', 'rewrite'];

const api = {
  invoke: (channel, payload) => {
    if (!CHANNELS.includes(channel)) return Promise.reject(new Error('未授权的通道: ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error('未授权的事件: ' + event);
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  platform: process.platform,
  version: process.versions.electron
};

contextBridge.exposeInMainWorld('wallnut', api);
