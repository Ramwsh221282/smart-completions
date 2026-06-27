// Backend lifecycle hook: starts the Rust core when the backend boots and stops
// it on shutdown. Guarding by the enable flag lives inside the service.

import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CoreBackendServiceImpl } from './core-backend-service';

@injectable()
export class CoreBackendContribution implements BackendApplicationContribution {
    @inject(CoreBackendServiceImpl)
    protected readonly core!: CoreBackendServiceImpl;

    async initialize(): Promise<void> {
        await this.core.initialize();
    }

    async onStop(): Promise<void> {
        await this.core.shutdown();
    }
}
