'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/** 开发/测试时可用 WALLNUT_DATA 覆盖数据目录。 */
function dataDir() {
  const dir = process.env.WALLNUT_DATA || (app ? app.getPath('userData') : path.join(process.cwd(), '.wallnut-data'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resourcesDir() {
  // 开发目录永远优先，避免 Electron 重命名 / Wallnut.exe 启动时误判 isPackaged。
  const dev = path.join(__dirname, '..', 'resources');
  if (fs.existsSync(dev)) return dev;
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'resources') : '',
    process.resourcesPath || '',
    path.join(path.dirname(process.execPath), 'resources')
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[0] || dev;
}

function coreBinary() {
  const name = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
  const candidates = [
    process.env.WALLNUT_CORE || '',
    path.join(resourcesDir(), 'core', name),
    process.resourcesPath ? path.join(process.resourcesPath, 'core', name) : '',
    path.join(path.dirname(process.execPath), 'resources', 'core', name),
    // 兼容项目早期 spike 目录；仅作开发兜底
    path.join(__dirname, '..', 'dev', 'spike', 'mihomo', process.platform === 'win32' ? 'mihomo-windows-amd64-compatible.exe' : 'mihomo')
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || path.join(resourcesDir(), 'core', name);
}

function geoFile(name) {
  return path.join(resourcesDir(), 'geo', name);
}

function subDir(...parts) {
  const dir = path.join(dataDir(), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(dataDir(), 'state.json');
}

function configPath() {
  return path.join(dataDir(), 'config.yaml');
}

module.exports = { dataDir, resourcesDir, coreBinary, geoFile, subDir, statePath, configPath };
