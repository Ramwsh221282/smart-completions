#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LEGACY_NES_DIR = path.join(ROOT, 'src', 'node', 'nes-module');
const SCAN_ROOTS = ['src', 'test', 'package.json'];

const FORBIDDEN_PATTERNS = [
    { label: 'legacy nes-module path', re: /node[\\/]nes-module/ },
    { label: 'legacy buildNesPrompt symbol', re: /\bbuildNesPrompt\b/ },
    { label: 'legacy BuildNesPromptInput symbol', re: /\bBuildNesPromptInput\b/ },
    { label: 'legacy BuiltNesPrompt symbol', re: /\bBuiltNesPrompt\b/ },
    { label: 'legacy parseNesCompletion symbol', re: /\bparseNesCompletion\b/ },
    { label: 'legacy formatRecentEdits helper', re: /\bformatRecentEdits(?:WithHeaders)?\b/ },
    { label: 'legacy zeta model literal', re: /['"`]zeta['"`]/ },
];

const failures = [];

if (fs.existsSync(LEGACY_NES_DIR)) {
    failures.push('src/node/nes-module still exists');
}

for (const target of SCAN_ROOTS) {
    const absolute = path.join(ROOT, target);
    if (!fs.existsSync(absolute)) {
        continue;
    }
    if (fs.statSync(absolute).isDirectory()) {
        for (const filePath of walkFiles(absolute)) {
            checkFile(filePath);
        }
    } else {
        checkFile(absolute);
    }
}

if (failures.length > 0) {
    console.error('Legacy NES check failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

function checkFile(filePath) {
    if (!shouldScan(filePath)) {
        return;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const relative = path.relative(ROOT, filePath);
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.re.test(text)) {
            failures.push(`${relative}: ${pattern.label}`);
        }
    }
}

function shouldScan(filePath) {
    return filePath.endsWith('.ts') || filePath.endsWith('.js') || filePath.endsWith('.json');
}

function* walkFiles(dir) {
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
