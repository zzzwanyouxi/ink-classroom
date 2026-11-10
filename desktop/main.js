'use strict';

const { app, BrowserWindow, protocol, net, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SCHEME = 'app';
const SELFTEST = process.argv.includes('--selftest');

if (SELFTEST) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

let win = null;

function serve(req) {
  try {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '/');
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.indexOf('..') >= 0) return new Response('Bad request', { status: 400 });
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}

/* ---------------- 工作文件夹 ---------------- */
function wsConfigFile() {
  return path.join(app.getPath('userData'), 'workspace.json');
}
function getWsDir() {
  try {
    const raw = fs.readFileSync(wsConfigFile(), 'utf8');
    const dir = JSON.parse(raw).dir;
    return typeof dir === 'string' && dir ? dir : null;
  } catch (e) {
    return null;
  }
}
function setWsDir(dir) {
  try {
    fs.mkdirSync(path.dirname(wsConfigFile()), { recursive: true });
    fs.writeFileSync(wsConfigFile(), JSON.stringify({ dir: dir }));
  } catch (e) { /* ignore */ }
}

ipcMain.handle('ws-pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择保存课堂笔记的文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  setWsDir(dir);
  return dir;
});

ipcMain.handle('ws-info', () => ({ dir: getWsDir() }));

ipcMain.handle('ws-save', (event, payload) => {
  const dir = getWsDir();
  if (!dir) return { ok: false, reason: 'no-workspace' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(payload.state));
    if (payload.assets) {
      fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify(payload.assets));
    }
    fs.writeFileSync(path.join(dir, 'readme.txt'),
      '这是「课堂笔记」的自动保存目录。\nnotes.json = 笔记本结构和笔迹；assets.json = 原卷图片。\n直接改文件可能被下次自动保存覆盖。\n');
    return { ok: true, dir: dir, at: Date.now() };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
});

ipcMain.handle('ws-load', () => {
  const dir = getWsDir();
  if (!dir) return null;
  try {
    const stateFile = path.join(dir, 'notes.json');
    if (!fs.existsSync(stateFile)) return null;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    let assets = null;
    const assetFile = path.join(dir, 'assets.json');
    if (fs.existsSync(assetFile)) {
      try { assets = JSON.parse(fs.readFileSync(assetFile, 'utf8')); } catch (e) { assets = null; }
    }
    return { state: state, assets: assets, dir: dir };
  } catch (err) {
    return null;
  }
});

ipcMain.handle('toggle-fullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle('set-fullscreen', (event, value) => {
  if (!win) return false;
  win.setFullScreen(!!value);
  return win.isFullScreen();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#eef0f5',
    title: '课堂笔记',
    icon: path.join(__dirname, 'app.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { if (!SELFTEST) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('enter-full-screen', () => win.webContents.send('fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen-changed', false));
  win.loadURL(SCHEME + '://local/index.html');
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  createWindow();
  if (SELFTEST) runSelfTest();
});

app.on('window-all-closed', () => app.quit());

async function runSelfTest() {
  setTimeout(async () => {
    try {
      const info = await win.webContents.executeJavaScript(
        'JSON.stringify({ title: document.title, idb: !!window.indexedDB, desktop: !!(window.inkDesktop && window.inkDesktop.isDesktop), canvas: !!document.getElementById("bg"), ribbon: !!document.getElementById("ribbon"), pens: document.querySelectorAll(".pen").length })'
      );
      console.log('SELFTEST ' + info);
      try {
        const api = await win.webContents.executeJavaScript('JSON.stringify({ api: typeof window.inkDesktop, setFS: typeof window.inkDesktop.setFullScreen, wsInfo: typeof window.inkDesktop.workspaceInfo })');
        console.log('PRELOAD ' + api);
        const wsInfo = await win.webContents.executeJavaScript('window.inkDesktop.workspaceInfo().then(function (i) { return JSON.stringify(i); })');
        console.log('WSINFO ' + wsInfo);
        const saveRes = await win.webContents.executeJavaScript('window.inkDesktop.saveWorkspace({ state: { probe: 1 }, assets: null }).then(function (r) { return JSON.stringify(r); })');
        console.log('WSSAVE ' + saveRes);
      } catch (err) {
        console.log('PRELOAD_FAIL ' + (err && err.message));
      }
      const img = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'ink-classroom-selftest.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SHOT ' + out);
    } catch (err) {
      console.log('SELFTEST_FAIL ' + (err && err.message));
    }
    app.quit();
  }, 5000);
}
