import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';
import { EmbeddingIndexService } from '../common/protocol';
import { NesController } from './nes-module/nes-controller';
import { SweepTelemetry } from './sweep/telemetry/sweep-telemetry';

export const RebuildIndexCommand: Command = {
    id: 'smart-completions.rebuildIndex',
    label: 'Smart Completions: Rebuild Index',
};

export const TestConnectionCommand: Command = {
    id: 'smart-completions.testConnection',
    label: 'Smart Completions: Test Embedding Connection',
};

export const FimAcceptCommand: Command = {
    id: 'smart-completions.fim.accept',
    label: 'Smart Completions: Accept FIM Suggestion',
};

export const NesAcceptCommand: Command = {
    id: 'smart-completions.nes.accept',
    label: 'Smart Completions: Accept NES Suggestion',
};

export const NesDismissCommand: Command = {
    id: 'smart-completions.nes.dismiss',
    label: 'Smart Completions: Dismiss NES Suggestion',
};

export const NesJumpOrAcceptCommand: Command = {
    id: 'smart-completions.nes.jumpOrAccept',
    label: 'Smart Completions: Jump or Accept NES Suggestion',
};

export const NesTelemetryDumpCommand: Command = {
    id: 'smart-completions.nes.telemetry.dump',
    label: 'Smart Completions: Dump NES Telemetry',
};

export const NesTelemetryResetCommand: Command = {
    id: 'smart-completions.nes.telemetry.reset',
    label: 'Smart Completions: Reset NES Telemetry',
};

@injectable()
export class SmartCompletionsCommands implements CommandContribution, KeybindingContribution {
    @inject(EmbeddingIndexService) private readonly indexService!: EmbeddingIndexService;
    @inject(MessageService) private readonly messages!: MessageService;
    @inject(MonacoEditorProvider) private readonly monacoEditors!: MonacoEditorProvider;
    @inject(NesController) private readonly nesController!: NesController;
    @inject(SweepTelemetry) private readonly telemetry!: SweepTelemetry;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(FimAcceptCommand, {
            execute: async () => this.monacoEditors.current?.runAction('editor.action.inlineSuggest.commit'),
        });
        registry.registerCommand(NesAcceptCommand, {
            execute: () => this.nesController.accept(),
        });
        registry.registerCommand(NesDismissCommand, {
            execute: () => this.nesController.dismiss(),
        });
        registry.registerCommand(NesJumpOrAcceptCommand, {
            execute: () => this.nesController.jumpOrAccept(),
        });
        registry.registerCommand(NesTelemetryDumpCommand, {
            execute: () => console.info('Smart Completions NES telemetry', this.telemetry.snapshot()),
        });
        registry.registerCommand(NesTelemetryResetCommand, {
            execute: () => this.telemetry.reset(),
        });
        registry.registerCommand(RebuildIndexCommand, {
            execute: async () => {
                await this.indexService.rebuild();
                this.messages.info('Smart Completions: index rebuild started');
            },
        });
        registry.registerCommand(TestConnectionCommand, {
            execute: async () => {
                const result = await this.indexService.testConnection({ kind: 'embedding', url: '' });
                this.messages.info(
                    `Embedding connection: ${result.ok ? 'OK' : 'FAILED'}${result.detail ? ` — ${result.detail}` : ''}`,
                );
            },
        });
    }

    registerKeybindings(registry: KeybindingRegistry): void {
        registry.registerKeybinding({
            command: FimAcceptCommand.id,
            keybinding: 'tab',
            when: 'inlineSuggestionVisible && !editorReadonly',
        });
        registry.registerKeybinding({
            command: NesJumpOrAcceptCommand.id,
            keybinding: 'alt+tab',
            when: '!editorReadonly',
        });
        registry.registerKeybinding({
            command: NesDismissCommand.id,
            keybinding: 'esc',
            when: '!editorReadonly',
        });
    }
}
