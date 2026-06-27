const DEFAULT_LANGUAGE = 'Text';

const LANGUAGE_DISPLAY_NAME = new Map<string, string>([
    ['python', 'Python'],
    ['java', 'Java'],
    ['javascript', 'JavaScript'],
    ['javascriptreact', 'JavaScript'],
    ['typescript', 'TypeScript'],
    ['typescriptreact', 'TypeScript'],
    ['c', 'C'],
    ['cpp', 'C++'],
    ['csharp', 'C#'],
    ['go', 'Go'],
    ['rust', 'Rust'],
    ['php', 'PHP'],
    ['ruby', 'Ruby'],
    ['kotlin', 'Kotlin'],
    ['swift', 'Swift'],
    ['scala', 'Scala'],
    ['shellscript', 'Shell'],
    ['sql', 'SQL'],
    ['lua', 'Lua'],
]);

export function buildAixcoderHeader(filePath: string, languageId: string): string {
    return `# the file path is: ${filePath}\n# the code file is written by ${languageDisplayName(languageId)}\n`;
}

export function languageDisplayName(languageId: string): string {
    const known = LANGUAGE_DISPLAY_NAME.get(languageId);
    if (known !== undefined) {
        return known;
    }
    if (languageId.length === 0) {
        return DEFAULT_LANGUAGE;
    }
    return `${languageId[0].toUpperCase()}${languageId.slice(1)}`;
}
