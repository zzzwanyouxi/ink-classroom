'use strict';

const path = require('path');
const rcedit = require('rcedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const appInfo = context.packager.appInfo;
  const exe = path.join(context.appOutDir, appInfo.productFilename + '.exe');
  const icon = path.join(__dirname, 'app.ico');
  await rcedit(exe, {
    icon: icon,
    'version-string': {
      CompanyName: 'zzzwanyouxi',
      FileDescription: '课堂手写白板',
      ProductName: '课堂笔记',
      LegalCopyright: 'Copyright © 2026 zzzwanyouxi',
      OriginalFilename: appInfo.productFilename + '.exe',
    },
    'file-version': appInfo.version,
    'product-version': appInfo.version,
  });
  console.log('rcedit done: ' + exe);
};
