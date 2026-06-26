import { injectable } from '@theia/core/shared/inversify';
import type { NesResponse } from '../../../common/nes-types';

/** Снимок frontend telemetry нужен для сравнения acceptance до и после изменений retrieval/gates. */
export interface SweepTelemetrySnapshot {
    status: Record<string, number>;
    rejectReasons: Record<string, number>;
    shown: number;
    accepted: number;
    dismissed: number;
    stale: number;
    acceptanceRate: number;
    p50: number;
    p95: number;
}

/** Frontend sink агрегирует predicted/shown/accepted/dismissed без отправки данных наружу. */
@injectable()
export class SweepTelemetry {
    private readonly statusCounts = new Map<string, number>();
    private readonly rejectReasons = new Map<string, number>();
    private shown = 0;
    private accepted = 0;
    private dismissed = 0;
    private stale = 0;
    private readonly latencyMs: number[] = [];

    /** Учитывает каждый backend predict outcome, включая no-edit/rejected/error. */
    recordPredicted(response: NesResponse): void {
        bump(this.statusCounts, response.meta.status);
        if (response.meta.rejectReason) {
            bump(this.rejectReasons, response.meta.rejectReason);
        }
        this.latencyMs.push(response.meta.durationMs);
    }

    /** Учитывает подсказку, реально показанную пользователю во View Zone. */
    recordShown(): void {
        this.shown++;
    }

    /** Учитывает принятие подсказки пользователем. */
    recordAccepted(): void {
        this.accepted++;
    }

    /** Учитывает dismiss любым путём: Esc, новый ввод, новый show или dispose. */
    recordDismissed(): void {
        this.dismissed++;
    }

    /** Учитывает backend-ответ, устаревший из-за изменения версии Monaco-модели. */
    recordStale(): void {
        this.stale++;
    }

    /** Возвращает агрегаты для команды dump без сброса накопленных счётчиков. */
    snapshot(): SweepTelemetrySnapshot {
        return {
            status: Object.fromEntries(this.statusCounts),
            rejectReasons: Object.fromEntries(this.rejectReasons),
            shown: this.shown,
            accepted: this.accepted,
            dismissed: this.dismissed,
            stale: this.stale,
            acceptanceRate: this.shown > 0 ? this.accepted / this.shown : 0,
            p50: percentile(this.latencyMs, 50),
            p95: percentile(this.latencyMs, 95),
        };
    }

    /** Очищает telemetry baseline перед новой ручной или battlefield-сессией. */
    reset(): void {
        this.statusCounts.clear();
        this.rejectReasons.clear();
        this.shown = 0;
        this.accepted = 0;
        this.dismissed = 0;
        this.stale = 0;
        this.latencyMs.length = 0;
    }
}

/** Увеличивает счётчик в Map без создания промежуточных объектов. */
function bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

/** Считает percentile по отсортированной копии, чтобы snapshot не менял порядок накопленных latency. */
function percentile(values: number[], pct: number): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
    return sorted[index];
}
