// Spawns and supervises the Rust core binary. Pure path/env helpers are
// exported separately so they can be unit-tested without spawning a process.

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Connection endpoint the spawned core listens on. */
export interface CoreEndpoint {
    socketPath: string;
}

/** Whether the Rust core path is enabled via environment flag. */
export function isCoreEnabled(env: NodeJS.ProcessEnv): boolean {
    return env.SMART_COMPLETIONS_RUST_CORE === '1';
}

/** Platform-specific binary file name. */
export function platformBinaryName(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'smart-completions-core.exe' : 'smart-completions-core';
}

/** Resolves the core binary path, honouring an explicit env override. */
export function resolveBinaryPath(
    env: NodeJS.ProcessEnv,
    cwd: string,
    platform: NodeJS.Platform,
): string {
    const override = env.SMART_COMPLETIONS_CORE_BIN;
    if (override && override.length > 0) {
        return override;
    }

    return path.resolve(cwd, 'resources', 'bin', platformBinaryName(platform));
}

/** Default per-process socket path (Unix domain socket or Windows named pipe). */
export function defaultSocketPath(platform: NodeJS.Platform, pid: number, tmpdir: string): string {
    if (platform === 'win32') {
        return `\\\\.\\pipe\\smart-completions-core-${pid}`;
    }

    return path.join(tmpdir, `smart-completions-core-${pid}.sock`);
}

/** Owns the child process lifecycle for the Rust core. */
export class CoreProcessManager {
    private child: ChildProcess | undefined;

    async start(): Promise<CoreEndpoint> {
        const socketPath = defaultSocketPath(process.platform, process.pid, os.tmpdir());
        const binaryPath = resolveBinaryPath(process.env, process.cwd(), process.platform);

        const child = spawn(binaryPath, ['--socket', socketPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'info' },
        });
        this.child = child;
        pipeStderr(child);

        await waitForSocket(socketPath);
        return { socketPath };
    }

    async stop(): Promise<void> {
        if (!this.child) {
            return;
        }

        this.child.kill('SIGTERM');
        this.child = undefined;
    }
}

function pipeStderr(child: ChildProcess): void {
    child.stderr?.on('data', chunk => {
        if (process.env.NODE_ENV === 'development') {
            console.error(`[smart-completions-core] ${String(chunk)}`);
        }
    });
}

async function waitForSocket(socketPath: string): Promise<void> {
    // A named pipe never appears on the filesystem, so wait by probing a
    // connection instead of an existsSync poll the way the unix path can.
    if (process.platform === 'win32') {
        await waitForConnectable(socketPath);
        return;
    }

    for (let attempt = 0; attempt < 100; attempt++) {
        if (fs.existsSync(socketPath)) {
            return;
        }
        await delay(20);
    }
}

async function waitForConnectable(socketPath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await canConnect(socketPath)) {
            return;
        }
        await delay(20);
    }
}

function canConnect(socketPath: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const socket = net.connect(socketPath);
        const settle = (ok: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
