#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const LIB_DIR = path.join(ROOT, 'lib');

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'prompt']);
const CONSOLE_METHODS = new Set(['debug', 'info', 'warn', 'error', 'log', 'trace', 'time', 'timeEnd']);
const LOGGER_CLASS_NAMES = new Set(['SweepLogger', 'ZetaLogger', 'FimLogger']);

for (const filePath of walkJsFiles(LIB_DIR)) {
  stripFile(filePath);
}

function stripFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result = ts.transform(sourceFile, [stripReleaseLogsTransformer]);
  const transformed = result.transformed[0];
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const nextText = printer.printFile(transformed);
  result.dispose();

  if (nextText !== sourceText) {
    fs.writeFileSync(filePath, `${nextText}\n`, 'utf8');
  }
}

function stripReleaseLogsTransformer(context) {
  const visitor = node => {
    if (isRemovableStatement(node)) {
      return undefined;
    }

    if (ts.isBlock(node)) {
      const statements = visitStatementList(node.statements, visitor, context);
      return ts.factory.updateBlock(node, statements);
    }

    if (ts.isIfStatement(node) && isNodeEnvDevelopmentCheck(node.expression)) {
      return undefined;
    }

    return ts.visitEachChild(node, visitor, context);
  };

  return node => ts.visitNode(node, visitor);
}

function visitStatementList(statements, visitor, context) {
  const kept = [];
  for (let i = 0; i < statements.length; i++) {
    const visited = ts.visitNode(statements[i], visitor);
    if (visited) kept.push(visited);
  }
  return ts.factory.createNodeArray(kept);
}

function isRemovableStatement(node) {
  if (ts.isExpressionStatement(node)) {
    return isLoggerCall(node.expression) || isConsoleCall(node.expression);
  }

  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.length > 0 &&
      node.declarationList.declarations.every(isRemovableVariableDeclaration);
  }

  return false;
}

function isRemovableVariableDeclaration(declaration) {
  const initializer = declaration.initializer;
  if (!initializer) return false;

  if (ts.isIdentifier(declaration.name) && declaration.name.text === 'LOG') {
    return isLoggerInstance(initializer);
  }

  // CommonJS output: const logger_1 = require('../../../common/sweep/logger');
  if (ts.isCallExpression(initializer) && isRequireCall(initializer)) {
    const specifier = initializer.arguments[0];
    return ts.isStringLiteral(specifier) && /\/logger$/.test(specifier.text);
  }

  return false;
}

function isLoggerInstance(expression) {
  if (!ts.isNewExpression(expression)) return false;
  const className = rightMostIdentifier(expression.expression);
  return className !== undefined && LOGGER_CLASS_NAMES.has(className);
}

function isLoggerCall(expression) {
  if (!ts.isCallExpression(expression)) return false;
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;

  const receiver = expression.expression.expression;
  const method = expression.expression.name.text;

  return ts.isIdentifier(receiver) && receiver.text === 'LOG' && LOG_METHODS.has(method);
}

function isConsoleCall(expression) {
  if (!ts.isCallExpression(expression)) return false;
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;

  const receiver = expression.expression.expression;
  const method = expression.expression.name.text;

  return ts.isIdentifier(receiver) && receiver.text === 'console' && CONSOLE_METHODS.has(method);
}

function isRequireCall(expression) {
  return ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
}

function rightMostIdentifier(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function isNodeEnvDevelopmentCheck(expression) {
  if (!ts.isBinaryExpression(expression)) return false;
  const operator = expression.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsToken) {
    return false;
  }

  return (isProcessEnvNodeEnv(expression.left) && isDevelopmentLiteral(expression.right)) ||
    (isProcessEnvNodeEnv(expression.right) && isDevelopmentLiteral(expression.left));
}

function isProcessEnvNodeEnv(expression) {
  return ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'NODE_ENV' &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'env' &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'process';
}

function isDevelopmentLiteral(expression) {
  return ts.isStringLiteral(expression) && expression.text === 'development';
}

function* walkJsFiles(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsFiles(absolute);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield absolute;
    }
  }
}
