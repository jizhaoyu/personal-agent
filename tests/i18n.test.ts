import test from 'node:test';
import assert from 'node:assert/strict';
import { zh } from '../src/i18n/zh';
import { en } from '../src/i18n/en';
import {
  formatArtifactStatus,
  formatArtifactType,
  formatBudgetAmount,
  formatConditionKind,
  formatConditionStatus,
  formatDealStage,
  formatExpenseCategory,
  formatShanghaiTime,
} from '../src/i18n/domain';
import { getLanguage, normalizeLanguage, setLanguage, subscribeLanguage } from '../src/i18n/store';
import { translate } from '../src/i18n/index';
import { alignmentText, createAlignmentDraft, inspectAlignmentBoundary } from '../src/services/aiService';
import { buildArtifactDraft } from '../src/services/artifacts';
import { buildTrialReport } from '../src/services/trialInfo';
import type { Engagement, ProjectTaskItem } from '../src/types';

function collectLeafEntries(tree: Record<string, unknown>, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      entries.set(pathKey, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subVal] of collectLeafEntries(value as Record<string, unknown>, pathKey)) {
        entries.set(subKey, subVal);
      }
    } else {
      assert.fail(`Unexpected non-string leaf value at ${pathKey}`);
    }
  }
  return entries;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
}

const CURRENCY_DIFF_KEYS = new Set([
  'cards.crmTotalValue',
  'cards.crmDealBudget',
  'cards.posterBudgetValue',
]);

const INTENTIONAL_EMPTY_EN_AFFIXES = new Set([
  'closure.budgetRefSuffix',
  'alignment.actionCountSuffix',
]);

test('zh and en dictionaries have 100% key parity, non-empty values, and aligned placeholders', () => {
  const zhLeaves = collectLeafEntries(zh as unknown as Record<string, unknown>);
  const enLeaves = collectLeafEntries(en as unknown as Record<string, unknown>);

  assert.ok(zhLeaves.size > 300, `Expected full translation coverage, got ${zhLeaves.size} keys`);
  for (const [key, zhValue] of zhLeaves) {
    assert.ok(enLeaves.has(key), `Missing English key: ${key}`);
    assert.ok(zhValue.trim().length > 0, `Empty zh translation at ${key}`);
    const enValue = enLeaves.get(key)!;
    if (!INTENTIONAL_EMPTY_EN_AFFIXES.has(key)) {
      assert.ok(enValue.trim().length > 0, `Empty en translation at ${key}`);
    }
    if (!CURRENCY_DIFF_KEYS.has(key)) {
      assert.deepEqual(
        placeholders(enValue),
        placeholders(zhValue),
        `Mismatched placeholders for ${key}`,
      );
    }
  }
  for (const key of enLeaves.keys()) {
    assert.ok(zhLeaves.has(key), `Extra English key not in zh: ${key}`);
  }
});

test('translate interpolates named variables and falls back safely', () => {
  assert.equal(translate('en', 'checkin.progressDays', { done: 3, target: 7 }), '3 / 7 days');
  assert.equal(translate('zh-CN', 'checkin.progressDays', { done: 3, target: 7 }), '3 / 7 天');
  assert.equal(translate('invalid' as any, 'header.workMode'), '工作态');
  assert.equal(translate('en', 'nonexistent.key' as any), 'nonexistent.key');
});

test('language store normalizes, notifies subscribers, and restores clean default', () => {
  const prev = getLanguage();
  const seen: string[] = [];
  const unsubscribe = subscribeLanguage(() => seen.push(getLanguage()));
  try {
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
    assert.equal(normalizeLanguage('fr-FR'), 'zh-CN');

    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    setLanguage('zh-CN');
    assert.equal(getLanguage(), 'zh-CN');
    assert.ok(seen.includes('en'));
    assert.ok(seen.includes('zh-CN'));
  } finally {
    unsubscribe();
    setLanguage(prev);
  }
});

test('domain formatters map canonical enums while preserving underlying Chinese defaults', () => {
  assert.equal(formatDealStage('方案报价', 'zh-CN'), '方案报价');
  assert.equal(formatDealStage('方案报价', 'en'), 'Proposal & Quote');
  assert.equal(formatConditionStatus('watching', 'en'), 'Watching');
  assert.equal(formatConditionKind('followup_resolved', 'en'), 'Ready once client dependency resolves');
  assert.equal(formatArtifactType('meeting_brief', 'en'), 'Meeting Brief');
  assert.equal(formatArtifactStatus('needs_review', 'en'), 'Needs Review');
  assert.equal(formatBudgetAmount(80000, 'zh-CN'), '¥80000');
  assert.equal(formatBudgetAmount(80000, 'en'), 'CNY 80,000');
  assert.equal(formatExpenseCategory('餐饮☕', 'en'), 'Food & Drinks ☕');
  assert.match(formatShanghaiTime('2026-11-02T09:00:00+08:00', 'en'), /2026/);
});

test('outbound alignment draft, artifact builder, and trial report honor lang=en without leaking private fields', () => {
  const project: Engagement = {
    id: 'eng-1',
    clientName: 'Lin Studio',
    title: 'Brand Website Revamp',
    stage: '方案报价',
    budgetAmount: 80000,
    internalContext: 'SECRET FLOOR 50000',
    shareableSummary: 'Homepage architecture reviewed; sending quote this Friday.',
    nextAction: 'Send revised proposal',
    updatedAt: Date.parse('2026-11-01T10:00:00+08:00'),
  };
  const tasks: ProjectTaskItem[] = [
    {
      id: 'task-1',
      engagementId: 'eng-1',
      title: 'Send wireframe v2',
      assignee: '我',
      deadline: '2026-11-06',
      dueAt: '2026-11-06T18:00:00+08:00',
      priority: 'high',
      done: false,
    },
  ];

  const boundary = inspectAlignmentBoundary(project, tasks, ['task-1'], false, 'en');
  assert.equal(boundary.internalNotesWithheld, true);
  assert.equal(boundary.budgetWithheld, true);
  assert.ok(boundary.withheldFields.some(line => line.includes('Internal notes withheld')));
  assert.ok(boundary.withheldFields.some(line => line.includes('Project budget hidden')));

  const draft = createAlignmentDraft(project, tasks, ['task-1'], false, 'en');
  const note = alignmentText(draft, 'en');
  assert.match(note, /Communication Notes Draft/);
  assert.match(note, /Client: Lin Studio/);
  assert.doesNotMatch(note, /SECRET FLOOR 50000/);
  assert.doesNotMatch(note, /80,000/);

  const artifact = buildArtifactDraft({
    type: 'proposal_brief',
    project,
    tasks,
    now: Date.parse('2026-11-01T10:00:00+08:00'),
    lang: 'en',
  });
  assert.match(artifact.title, /Proposal Brief/);
  assert.match(artifact.content, /Proposal & Quote/);
  assert.match(artifact.content, /CNY 80,000/);
  assert.doesNotMatch(artifact.content, /SECRET FLOOR 50000/);

  const report = buildTrialReport({
    buildInfo: {
      productVersion: '1.0.0',
      buildId: 'test-build',
      builtAt: '2026-11-16T00:00:00Z',
      channel: 'desktop-trial',
    },
    context: { mode: 'work', phase: 'review', hasError: false },
    details: { expected: 'English report renders', repeatability: 'yes' },
  }, Date.parse('2026-11-16T02:00:00Z'), 'en');
  assert.match(report, /Looma Trial Issue Report/);
  assert.match(report, /Space: Work/);
  assert.match(report, /Step: Reviewing Proposal/);
  assert.match(report, /Reproducible: Reproducible/);
});
