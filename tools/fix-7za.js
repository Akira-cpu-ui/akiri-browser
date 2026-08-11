// Patches node_modules/7zip-bin so that all 7za invocations go through the
// wrapper at bin/7za.exe. The wrapper drops the "-snld" flag and treats
// symlink-creation failures (no admin rights on Windows) as non-fatal.
// Idempotent: safe to run before every build.
'use strict';

const fs = require('fs');
const path = require('path');

const pkgDir = path.join(__dirname, '..', 'node_modules', '7zip-bin');
const indexPath = path.join(pkgDir, 'index.js');
const wrapPath = path.join(__dirname, '..', 'bin', '7za.exe');

if (!fs.existsSync(wrapPath)) {
  console.error('bin/7za.exe not found. Build it with:');
  console.error('  python -m PyInstaller --onefile --console --distpath bin --workpath tools/build --specpath tools --name 7za tools/7za-wrap.py');
  process.exit(1);
}

const content = `"use strict"

const path = require("path")
const fs = require("fs")

function getPath() {
  // Akiri build fix: use a wrapper that strips "-snld" (symlink creation fails
  // without admin rights on Windows). Falls back to the bundled binary.
  const wrap = ${JSON.stringify(wrapPath.replace(/\\/g, '/'))}
  if (process.platform === "win32" && fs.existsSync(wrap)) {
    return wrap
  }
  if (process.platform === "darwin") {
    return path.join(__dirname, "mac", process.arch, "7za")
  }
  else if (process.platform === "win32") {
    return path.join(__dirname, "win", process.arch, "7za.exe")
  }
  else {
    return path.join(__dirname, "linux", process.arch, "7za")
  }
}

exports.path7za = getPath()
exports.path7x = path.join(__dirname, "7x.sh")
`;

fs.writeFileSync(indexPath, content);
console.log('7zip-bin patched ->', require('7zip-bin').path7za);
