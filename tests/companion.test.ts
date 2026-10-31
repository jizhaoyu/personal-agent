import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let states: any = {};
try { states = require('../src/services/companionState'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }

function derive(signals: Record<string, unknown>) {
  assert.equal(typeof states.deriveCompanionState, 'function', 'the real companion state derivation must exist');
  return states.deriveCompanionState(signals);
}

function component() {
  const filename = path.join(process.cwd(), 'src/components/Companion.tsx');
  assert.ok(fs.existsSync(filename), 'the original companion component must exist');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (dependency: string) => {
      if (dependency === 'react') return React;
      if (dependency === '../services/companionState') return states;
      if (dependency.endsWith('.css')) return {};
      return require(dependency);
    },
  }, { filename });
  return module.exports.Companion;
}

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(React.createElement(component(), { state: 'idle', mode: 'work', ...props }));
}

function find(node: any, predicate: (value: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(item => find(item, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

test('companion shows a real failure ahead of all success and pending signals', () => {
  assert.equal(derive({ error: 'disk full', busy: true, pending: true, saved: true, reminderCount: 3 }), 'error');
});

test('companion shows actual async work before a preview or saved receipt', () => {
  assert.equal(derive({ busy: true, pending: true, saved: true, reminderCount: 3 }), 'thinking');
  assert.equal(derive({ busy: false, pending: true, saved: true, reminderCount: 3 }), 'review');
});

test('companion only shows saved when it receives a persistence success signal', () => {
  assert.equal(derive({ saved: true, reminderCount: 3 }), 'saved');
  assert.equal(derive({ saved: false, reminderCount: 3 }), 'reminder');
  assert.equal(derive({ busy: false, pending: false, saved: false, error: false, reminderCount: 0 }), 'idle');
});

test('invalid reminder counts never create a fictional reminder', () => {
  for (const reminderCount of [-1, Number.NaN, Infinity, -Infinity]) {
    assert.equal(derive({ reminderCount }), 'idle');
  }
});

test('each real state has visible status text and a polite screen reader announcement', () => {
  for (const [state, expression] of [
    ['idle', /随时|我在|待机/], ['thinking', /整理/], ['review', /核对/],
    ['saved', /保存/], ['reminder', /待跟进|提醒/], ['error', /处理|失败/],
  ] as const) {
    const html = render({ state, reminderCount: 4 });
    assert.match(html, expression);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<svg/);
    assert.doesNotMatch(html, /<image|<audio|autofocus|https?:\/\//i);
  }
});

test('compact companion never renders a custom status containing private records', () => {
  const secret = '王总预算20万；家人体重变化；原始聊天';
  const html = render({ compact: true, state: 'reminder', reminderCount: 12, statusText: secret });
  assert.doesNotMatch(html, /王总|20万|家人|原始聊天/);
  assert.match(html, /12/);
  assert.match(html, /待跟进|提醒/);
});

test('embedded companion can show a specific operation status without losing the canonical state', () => {
  const html = render({ state: 'review', statusText: '请核对本次金额和时间' });
  assert.match(html, /请核对本次金额和时间/);
  assert.match(html, /待核对/);
});

test('restore and memory are keyboard native buttons with distinct working callbacks', () => {
  let toggles = 0;
  let memories = 0;
  const tree = component()({ state: 'idle', mode: 'work', compact: true, onToggle: () => toggles++, onOpenMemory: () => memories++ });
  const restore = find(tree, value => value.type === 'button' && /展开/.test(value.props['aria-label'] ?? ''));
  const memory = find(tree, value => value.type === 'button' && /记忆/.test(value.props['aria-label'] ?? ''));
  assert.ok(restore, 'capsule needs an explicitly labelled native restore button');
  assert.ok(memory, 'memory is a separate labelled native button');
  assert.equal(restore.props.type, 'button');
  assert.equal(memory.props.type, 'button');
  assert.equal(find(restore.props.children, value => value.type === 'button'), undefined, 'interactive controls cannot be nested');
  restore.props.onClick();
  memory.props.onClick();
  assert.equal(toggles, 1);
  assert.equal(memories, 1);
});

test('static companion does not offer nonfunctional buttons when callbacks are absent', () => {
  const html = render({ compact: true });
  assert.doesNotMatch(html, /<button/);
});

test('life and work reuse the same character while preserving their visible mode', () => {
  const life = render({ mode: 'life', name: '小芽' });
  const work = render({ mode: 'work', name: '小芽' });
  assert.match(life, /生活/);
  assert.match(work, /工作/);
  assert.match(life, /小芽/);
  assert.match(work, /小芽/);
  assert.equal((life.match(/<path/g) ?? []).length, (work.match(/<path/g) ?? []).length);
});

test('reminder copy normalizes invalid counts and bounds display without exposing raw values', () => {
  assert.doesNotMatch(render({ state: 'reminder', reminderCount: Number.NaN }), /NaN|Infinity/);
  assert.doesNotMatch(render({ state: 'reminder', reminderCount: -10 }), /-10/);
  assert.match(render({ state: 'reminder', reminderCount: 132 }), /99\+/);
});
