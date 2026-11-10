'use strict';

const { app, BrowserWindow, protocol, net, Menu, shell } = require('electron');
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
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { if (!SELFTEST) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
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
        'JSON.stringify({ title: document.title, idb: !!window.indexedDB, ls: !!window.localStorage, canvas: !!document.getElementById("bg"), ribbon: !!document.getElementById("ribbon"), pens: document.querySelectorAll(".pen").length })'
      );
      console.log('SELFTEST ' + info);
      const img = await win.webContents.capturePage();
      const out = path.join(ROOT, '..', 'dist-app-shot.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SHOT ' + out);
    } catch (err) {
      console.log('SELFTEST_FAIL ' + (err && err.message));
    }
    app.quit();
  }, 5000);
}
