// Backend RPC service: owns the Rust core process and forwards document sync
// and completion frames. Every method is a no-op when the core is disabled or
// not running, so the TypeScript pipelines keep working as the fallback.

import { injectable } from '@theia/core/shared/inversify';
import {
    CoreBackendService,
    CoreCompletionRequest,
    CoreCompletionResult,
    CoreDocumentChange,
    CoreInitialDocumentSnapshot,
    CoreStatus,
} from '../../common/core/core-protocol';
import { CoreIpcClient } from './core-ipc-client';
import { CoreProcessManager, isCoreEnabled, resolveBinaryPath } from './core-process-manager';

@injectable()
export class CoreBackendServiceImpl implements CoreBackendService {
    private readonly processManager = new CoreProcessManager();
    private readonly ipc = new CoreIpcClient();
    private started = false;
    private binaryPath: string | undefined;
    private socketPath: string | undefined;
    private lastError: string | undefined;

    async initialize(): Promise<void> {
        if (!isCoreEnabled(process.env)) {
            return;
        }

        this.binaryPath = resolveBinaryPath(process.env, process.cwd(), process.platform);
        await this.startCore();
    }

    async shutdown(): Promise<void> {
        await this.ipc.shutdown().catch(() => undefined);
        await this.processManager.stop().catch(() => undefined);
        this.started = false;
    }

    async syncInitialDocument(snapshot: CoreInitialDocumentSnapshot): Promise<void> {
        if (!this.started) {
            return;
        }
        await this.ipc.sendInitialDocument(snapshot);
    }

    async applyDocumentChange(change: CoreDocumentChange): Promise<void> {
        if (!this.started) {
            return;
        }
        await this.ipc.sendDocumentChange(change);
    }

    async requestCompletion(request: CoreCompletionRequest): Promise<CoreCompletionResult> {
        if (!this.started) {
            return { accepted: false, text: '', reason: 'rust core disabled or not running' };
        }

        try {
            const text = await this.ipc.requestCompletion(request);
            return { accepted: true, text };
        } catch (error) {
            return { accepted: false, text: '', reason: String(error) };
        }
    }

    async cancel(requestId: number): Promise<void> {
        if (!this.started) {
            return;
        }
        await this.ipc.cancel(requestId);
    }

    async getStatus(): Promise<CoreStatus> {
        return {
            enabled: isCoreEnabled(process.env),
            running: this.started,
            binaryPath: this.binaryPath,
            socketPath: this.socketPath,
            lastError: this.lastError,
        };
    }

    private async startCore(): Promise<void> {
        try {
            const endpoint = await this.processManager.start();
            await this.ipc.connect(endpoint.socketPath);
            this.socketPath = endpoint.socketPath;
            this.started = true;
        } catch (error) {
            this.lastError = String(error);
            this.started = false;
        }
    }
}
