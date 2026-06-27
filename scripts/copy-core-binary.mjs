#!/usr/bin/env node
// Copies the release smart-completions-core binary into resources/bin so it
// ships in the npm/electron artifact. Run after `npm run build:core`. Only the
// binary is bundled; Rust sources and target/ never ship.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ext = process.platform === 'win32' ? '.exe' : '';
const binaryName = `smart-completions-core${ext}`;
const source = path.join(root, 'smart-completions-core', 'target', 'release', binaryName);
const targetDir = path.join(root, 'resources', 'bin');
const target = path.join(targetDir, binaryName);

if (!fs.existsSync(source)) {
    console.error(`Core binary not found at ${source}. Run "npm run build:core" first.`);
    process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
}

console.log(`Copied ${source} -> ${target}`);
