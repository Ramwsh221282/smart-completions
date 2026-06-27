#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LIB_DIR = path.join(ROOT, 'lib');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

const FORBIDDEN_PATTERNS = [
  { label: 'console call', re: /\bconsole\.(?:debug|info|warn|error|log|trace|time|timeEnd)\b/ },
  { label: 'LOG call', re: /\bLOG\.(?:debug|info|warn|error|prompt)\b/ },
  { label: 'logger instance', re: /new\s+(?:[A-Za-z0-9_$]+\.)?(?:SweepLogger|ZetaLogger|FimLogger)\b/ },
  { label: 'logger class definition', re: /\bclass\s+(?:SweepLogger|ZetaLogger|FimLogger)\b/ },
  { label: 'logger module reference', re: /(?:common|\.\.?)[\\/](?:sweep|zeta21|fim)[\\/]logger\b/ },
  { label: 'prompt text log marker', re: /prompt text:/ },
  { label: 'raw response log marker', re: /raw response text/ },
];

const failures = [];

checkPackageFiles();

for (const filePath of walkFiles(LIB_DIR)) {
  if (!shouldScan(filePath)) continue;
  checkFile(filePath);
}

if (failures.length > 0) {
  console.error('Release log check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function checkPackageFiles() {
  const json = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const files = Array.isArray(json.files) ? json.files : [];
  if (files.includes('src')) {
    failures.push('package.json files includes src');
  }
}

function checkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const relative = path.relative(ROOT, filePath);

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(text)) {
      failures.push(`${relative}: ${pattern.label}`);
    }
  }
}

function shouldScan(filePath) {
  return filePath.endsWith('.js') || filePath.endsWith('.json');
}

function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}
