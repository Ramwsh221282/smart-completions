import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSweepCodeLanguage, sweepGrammarForLanguage, sweepLanguageIdForExtension } from '../src/node/sweep/retrieval/graph/sweep-language-registry';

/** Проверяет Sweep-local registry, включая Nix/Nim code-mode языки. */
test('sweep graph language registry maps code languages and leaves prose unsupported', () => {
    assert.equal(sweepGrammarForLanguage('typescript'), 'typescript');
    assert.equal(sweepGrammarForLanguage('nix'), 'nix');
    assert.equal(sweepGrammarForLanguage('nim'), 'nim');
    assert.equal(sweepGrammarForLanguage('markdown'), undefined);
    assert.equal(isSweepCodeLanguage('nix'), true);
    assert.equal(isSweepCodeLanguage('plaintext'), false);
    assert.equal(sweepLanguageIdForExtension('.nim'), 'nim');
    assert.equal(sweepLanguageIdForExtension('.md'), 'plaintext');
});
