#!/usr/bin/env python3
"""CPU-only character n-gram intent baseline; no executable model deserialization."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re
import unicodedata

BASE = Path(__file__).resolve().parent
LABELS = ('original_only', 'capture', 'reminder', 'suggest', 'complete', 'cancel', 'change', 'review')


def normalized(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text).lower())


def features(text):
    text = '^' + normalized(text) + '$'
    return Counter(text[i:i+n] for n in (1, 2, 3) for i in range(len(text)-n+1))


def read_splits(root):
    seen, groups, splits = set(), {}, {}
    for split in ('train', 'validation', 'test'):
        rows = [json.loads(line) for line in (root / (split + '.jsonl')).read_text(encoding='utf-8').splitlines() if line.strip()]
        for row in rows:
            key = normalized(row['text'])
            group = row['group']
            if not key or key in seen or not group or groups.get(group, split) != split or row['intent'] not in LABELS:
                raise ValueError(f'{split}: invalid/duplicate example or group leakage: {group}')
            seen.add(key)
            groups[group] = split
        if set(r['intent'] for r in rows) != set(LABELS):
            raise ValueError(f'{split}: missing one or more intent labels')
        splits[split] = rows
    return splits


def fit(rows):
    counts = {label: Counter() for label in LABELS}
    documents = Counter()
    vocab = set()
    for row in rows:
        label, grams = row['intent'], features(row['text'])
        documents[label] += 1
        counts[label].update(grams)
        vocab.update(grams)
    return {'version': 1, 'documents': dict(documents), 'counts': {k: dict(v) for k, v in counts.items()},
            'totals': {k: sum(v.values()) for k, v in counts.items()}, 'vocab': sorted(vocab)}


def rank(model, text):
    vocab = set(model['vocab'])
    grams = [(g, n) for g, n in features(text).items() if g in vocab]
    scores = {}
    for label in LABELS:
        counts = model['counts'][label]
        denominator = model['totals'][label] + len(vocab)
        scores[label] = math.log(model['documents'][label]) + sum(
            n * math.log((counts.get(g, 0) + 1) / denominator) for g, n in grams)
    # Margin is a heuristic score, not a calibrated confidence probability.
    best, runner = sorted(scores, key=scores.get, reverse=True)[:2]
    return best, (scores[best] - scores[runner]) / max(1, sum(n for _, n in grams)), bool(grams)


def predict(model, text):
    label, margin, matched = rank(model, text)
    threshold = model['thresholds'][label]
    accepted = matched and threshold is not None and margin >= threshold
    return {'intent': label if accepted else 'needs_review', 'top_candidate': label,
            'margin': round(margin, 6), 'accepted': accepted, 'execution_authorized': False}


def tune(model, rows, precision, min_support):
    ranked = [(row['intent'], *rank(model, row['text'])) for row in rows]
    thresholds = {}
    for label in LABELS:
        offered = [(truth, margin) for truth, top, margin, matched in ranked if top == label and matched]
        thresholds[label] = None
        for cut in sorted(set(m for _, m in offered)):
            eligible = [truth for truth, m in offered if m >= cut]
            if len(eligible) >= min_support and eligible.count(label) / len(eligible) >= precision:
                thresholds[label] = cut
                break
    return thresholds


def evaluate(model, rows):
    details = [{'text': row['text'], 'expected': row['intent'], **predict(model, row['text'])} for row in rows]
    accepted = [row for row in details if row['accepted']]
    correct_accepted = sum(row['intent'] == row['expected'] for row in accepted)
    return {'samples': len(details), 'raw_top1_accuracy': sum(r['top_candidate'] == r['expected'] for r in details)/len(details),
            'coverage': len(accepted)/len(details), 'accepted_precision': correct_accepted/len(accepted) if accepted else None,
            'accepted_false_completion': sum(r['intent'] == 'complete' and r['expected'] != 'complete' for r in accepted),
            'per_intent': {label: {'samples': sum(r['expected']==label for r in details),
                'correct_accepted': sum(r['expected']==label and r['intent']==label for r in details)} for label in LABELS},
            'examples': details}


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    train = sub.add_parser('train')
    train.add_argument('--data', type=Path, default=BASE/'data')
    train.add_argument('--out', type=Path, default=BASE/'artifacts')
    train.add_argument('--target-precision', type=float, default=0.9)
    train.add_argument('--min-validation-support', type=int, default=2)
    infer = sub.add_parser('predict')
    infer.add_argument('--model', type=Path, default=BASE/'artifacts'/'model.json')
    infer.add_argument('--text', required=True)
    args = parser.parse_args()
    if args.command == 'train':
        if not 0 < args.target_precision <= 1 or args.min_validation_support < 1:
            parser.error('invalid threshold settings')
        splits = read_splits(args.data)
        model = fit(splits['train'])
        model['thresholds'] = tune(model, splits['validation'], args.target_precision, args.min_validation_support)
        report = {'split_sizes': {k: len(v) for k, v in splits.items()}, 'thresholds': model['thresholds'],
                  'validation': evaluate(model, splits['validation']), 'test': evaluate(model, splits['test'])}
        dump(args.out/'model.json', model)
        dump(args.out/'metrics.json', report)
        print(json.dumps({**report['split_sizes'], **{k:v for k,v in report['test'].items() if k not in ('examples','per_intent')}}, ensure_ascii=False, indent=2))
    else:
        model = json.loads(args.model.read_text(encoding='utf-8'))
        if model.get('version') != 1:
            raise ValueError('unsupported model version')
        print(json.dumps(predict(model, args.text), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
