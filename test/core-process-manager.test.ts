import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultSocketPath,
    isCoreEnabled,
    platformBinaryName,
    resolveBinaryPath,
} from '../src/node/core/core-process-manager';

test('binary name carries the .exe suffix only on windows', () => {
    assert.equal(platformBinaryName('linux'), 'smart-completions-core');
    assert.equal(platformBinaryName('win32'), 'smart-completions-core.exe');
});

test('binary path honours the explicit env override', () => {
    const resolved = resolveBinaryPath({ SMART_COMPLETIONS_CORE_BIN: '/opt/core' }, '/work', 'linux');
    assert.equal(resolved, '/opt/core');
});

test('binary path defaults to the bundled resource', () => {
    const resolved = resolveBinaryPath({}, '/work', 'linux');
    assert.equal(resolved, '/work/resources/bin/smart-completions-core');
});

test('socket path differs by platform', () => {
    assert.equal(defaultSocketPath('linux', 42, '/tmp'), '/tmp/smart-completions-core-42.sock');
    assert.equal(defaultSocketPath('win32', 42, '/tmp'), '\\\\.\\pipe\\smart-completions-core-42');
});

test('core is enabled only by the explicit flag', () => {
    assert.equal(isCoreEnabled({ SMART_COMPLETIONS_RUST_CORE: '1' }), true);
    assert.equal(isCoreEnabled({}), false);
    assert.equal(isCoreEnabled({ SMART_COMPLETIONS_RUST_CORE: '0' }), false);
});
