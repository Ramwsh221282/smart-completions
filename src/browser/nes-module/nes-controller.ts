import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Disposable } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { NesViewZoneRenderer } from '../nes-render/nes-view-zone-renderer';
import { SweepController } from '../sweep/trigger-layer/sweep-controller';
import { ZetaController } from '../zeta21/trigger-layer/zeta-controller';

/** Facade-контроллер держит один публичный NES API для команд, пока внутри проекта одновременно живут sweep и zeta21 pipelines. */
@injectable()
export class NesController implements FrontendApplicationContribution, Disposable {
    @inject(SweepController) private readonly sweep!: SweepController;
    @inject(ZetaController) private readonly zeta!: ZetaController;
    @inject(NesViewZoneRenderer) private readonly renderer!: NesViewZoneRenderer;

    /** Поднимает оба pipeline, а активную модель дальше выбирает их собственный model-gating. */
    async onStart(): Promise<void> {
        await this.sweep.onStart();
        await this.zeta.onStart();
    }

    /** Принимает текущую видимую NES-подсказку через общий renderer, не привязываясь к конкретному backend path. */
    accept(): void {
        this.renderer.accept();
    }

    /** Скрывает текущую видимую NES-подсказку через общий renderer. */
    dismiss(): void {
        this.renderer.dismiss();
    }

    /** Перепрыгивает к месту удалённой правки; при повторном вызове в том же месте принимает edit. */
    jumpOrAccept(): void {
        this.renderer.jumpOrAccept();
    }

    /** Освобождает оба pipeline при остановке frontend contribution. */
    dispose(): void {
        this.sweep.dispose();
        this.zeta.dispose();
    }
}
