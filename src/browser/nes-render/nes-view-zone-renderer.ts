import { injectable } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common';
import * as monaco from '@theia/monaco-editor-core';
import { PositionDTO, TextEditDTO } from '../../common/editor-dto';
import { NesResponse } from '../../common/nes-types';

/** Единственный рендерер NES-подсказок: не зависит от модели, используется всеми Sweep/Zeta-путями через SweepController. */
@injectable()
export class NesViewZoneRenderer {
    // Редактор в котором сейчас показана подсказка; нужен для применения правки и удаления View Zone.
    private editor: monaco.editor.ICodeEditor | undefined;
    // ID активной View Zone; нужен чтобы точечно удалить её при dismiss без перерисовки других зон.
    private zoneId: string | undefined;
    // Последний NES-ответ; нужен для применения правки при accept и навигации при jumpOrAccept.
    private response: NesResponse | undefined;
    // Флаг accept-пути не даёт onDidChangeContent засчитать принятую подсказку как dismiss.
    private accepting = false;
    // Событие показа подсказки — источник denominator для acceptance rate.
    private readonly onDidShowEmitter = new Emitter<NesResponse>();
    // Событие принятия подсказки — источник numerator для acceptance rate.
    private readonly onDidAcceptEmitter = new Emitter<NesResponse>();
    // Событие явного или implicit dismiss — нужно учитывать устаревшие подсказки.
    private readonly onDidDismissEmitter = new Emitter<NesResponse>();
    readonly onDidShow = this.onDidShowEmitter.event;
    readonly onDidAccept = this.onDidAcceptEmitter.event;
    readonly onDidDismiss = this.onDidDismissEmitter.event;

    /**
     * Показывает View Zone с предпросмотром правки под первой строкой предлагаемого диапазона;
     * перед показом всегда сбрасывает предыдущую подсказку чтобы не накапливать зоны.
     */
    show(editor: monaco.editor.ICodeEditor, response: NesResponse): void {
        this.dismiss();
        if (response.edits.length === 0) {
            return;
        }
        this.editor = editor;
        this.response = response;
        const node = this.createNode(response);
        const afterLineNumber = Math.max(0, (response.primaryRange?.start.line ?? 0) + 1);
        editor.changeViewZones(accessor => {
            this.zoneId = accessor.addZone({
                afterLineNumber,
                heightInLines: Math.min(12, Math.max(3, lineCount(response.edits[0].newText) + 2)),
                domNode: node,
                suppressMouseDown: true,
            });
        });
        this.onDidShowEmitter.fire(response);
    }

    /**
     * Применяет правку из активного NES-ответа в редактор и убирает View Zone;
     * если в ответе есть jumpTo — перемещает курсор к целевой позиции.
     */
    accept(): void {
        const editor = this.editor;
        const response = this.response;
        if (!editor || !response || response.edits.length === 0) {
            return;
        }
        this.accepting = true;
        try {
            editor.executeEdits('smart-completions-nes', response.edits.map(toMonacoEdit));
            if (response.jumpTo) {
                editor.setPosition(toMonacoPosition(response.jumpTo));
                editor.revealPositionInCenterIfOutsideViewport(toMonacoPosition(response.jumpTo));
            }
            this.onDidAcceptEmitter.fire(response);
        } finally {
            this.accepting = false;
            this.clear();
        }
    }

    /**
     * Перемещает курсор к месту правки при первом вызове и принимает правку при повторном;
     * нужен для keybinding Alt+Tab чтобы пользователь мог сначала осмотреть правку.
     */
    jumpOrAccept(): void {
        const editor = this.editor;
        const response = this.response;
        if (!editor || !response?.jumpTo) {
            this.accept();
            return;
        }
        const current = editor.getPosition();
        const target = toMonacoPosition(response.jumpTo);
        if (current && current.lineNumber === target.lineNumber && current.column === target.column) {
            this.accept();
            return;
        }
        editor.setPosition(target);
        editor.revealPositionInCenterIfOutsideViewport(target);
    }

    /**
     * Убирает View Zone из редактора и сбрасывает внутреннее состояние рендерера;
     * вызывается при каждом новом изменении контента чтобы устаревшая подсказка не висела.
     */
    dismiss(): void {
        const response = this.response;
        const shouldFireDismiss = response !== undefined && !this.accepting;
        this.clear();
        if (shouldFireDismiss) {
            this.onDidDismissEmitter.fire(response);
        }
    }

    /** Сообщает trigger/render слоям, что NES View Zone сейчас занимает приоритетный канал. */
    isVisible(): boolean {
        return this.zoneId !== undefined && this.response !== undefined;
    }

    /** Удаляет активную View Zone и сбрасывает состояние без telemetry-события. */
    private clear(): void {
        if (this.editor && this.zoneId) {
            const zoneId = this.zoneId;
            this.editor.changeViewZones(accessor => accessor.removeZone(zoneId));
        }
        this.zoneId = undefined;
        this.response = undefined;
        this.editor = undefined;
    }

    /**
     * Создаёт DOM-узел с предпросмотром предлагаемого текста и подсказкой по keybindings,
     * чтобы пользователь видел правку до её принятия и знал как с ней взаимодействовать.
     */
    private createNode(response: NesResponse): HTMLElement {
        const node = document.createElement('div');
        node.style.boxSizing = 'border-box';
        node.style.height = '100%';
        node.style.padding = '6px 10px';
        node.style.border = '1px solid var(--theia-editorWidget-border)';
        node.style.background = 'var(--theia-editorWidget-background)';
        node.style.color = 'var(--theia-editorWidget-foreground)';
        node.style.fontFamily = 'var(--theia-ui-font-family)';
        node.style.fontSize = '12px';
        node.style.overflow = 'hidden';
        const title = document.createElement('div');
        title.textContent = `Next edit suggestion · ${response.modelId} · Alt+Tab jump/accept · Esc dismiss`;
        title.style.opacity = '0.8';
        title.style.marginBottom = '4px';
        const pre = document.createElement('pre');
        pre.textContent = response.edits.map(edit => edit.newText).join('\n');
        pre.style.margin = '0';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontFamily = 'var(--theia-editor-font-family)';
        node.appendChild(title);
        node.appendChild(pre);
        return node;
    }
}

/**
 * Конвертирует протокольный TextEditDTO в формат Monaco IIdentifiedSingleEditOperation,
 * чтобы executeEdits применил правку с корректными 1-based координатами.
 */
function toMonacoEdit(edit: TextEditDTO): monaco.editor.IIdentifiedSingleEditOperation {
    return {
        range: new monaco.Range(
            edit.range.start.line + 1,
            edit.range.start.character + 1,
            edit.range.end.line + 1,
            edit.range.end.character + 1,
        ),
        text: edit.newText,
        forceMoveMarkers: true,
    };
}

/**
 * Конвертирует протокольную 0-based позицию в 1-based Monaco Position
 * для setPosition и revealPositionInCenterIfOutsideViewport.
 */
function toMonacoPosition(position: PositionDTO): monaco.Position {
    return new monaco.Position(position.line + 1, position.character + 1);
}

/**
 * Считает строки предлагаемого текста чтобы View Zone зарезервировала достаточно высоты
 * и пользователь видел весь предпросмотр без скролла внутри зоны.
 */
function lineCount(text: string): number {
    return text.split('\n').length;
}
