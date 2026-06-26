// Лёгкие DTO геометрии/диагностик для передачи по RPC (без типов Monaco/vscode).

export interface PositionDTO {
    /** 0-based строка. */
    line: number;
    /** 0-based столбец (UTF-16). */
    character: number;
}

export interface RangeDTO {
    start: PositionDTO;
    end: PositionDTO;
}

export interface TextEditDTO {
    range: RangeDTO;
    newText: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagnosticDTO {
    range: RangeDTO;
    severity: DiagnosticSeverity;
    message: string;
    code?: string;
}
