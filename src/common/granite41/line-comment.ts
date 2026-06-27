const DEFAULT_LINE_COMMENT = '//';

const LINE_COMMENT_BY_LANGUAGE = new Map<string, string>([
    ['python', '#'],
    ['ruby', '#'],
    ['shellscript', '#'],
    ['sh', '#'],
    ['perl', '#'],
    ['r', '#'],
    ['yaml', '#'],
    ['toml', '#'],
    ['dockerfile', '#'],
    ['makefile', '#'],
    ['c', '//'],
    ['cpp', '//'],
    ['csharp', '//'],
    ['java', '//'],
    ['javascript', '//'],
    ['javascriptreact', '//'],
    ['typescript', '//'],
    ['typescriptreact', '//'],
    ['go', '//'],
    ['rust', '//'],
    ['kotlin', '//'],
    ['swift', '//'],
    ['scala', '//'],
    ['php', '//'],
    ['sql', '--'],
    ['lua', '--'],
    ['haskell', '--'],
    ['ada', '--'],
    ['clojure', ';;'],
    ['lisp', ';;'],
    ['scheme', ';;'],
]);

export function lineCommentForLanguage(languageId: string): string {
    return LINE_COMMENT_BY_LANGUAGE.get(languageId) ?? DEFAULT_LINE_COMMENT;
}
