#!/usr/bin/env python3
"""Train and publish a portable result ZIP only after successful verification."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

from train import LABELS, evaluate, normalized, read_splits

ROOT = Path(__file__).resolve().parent


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=ROOT / 'data')
    parser.add_argument('--out', type=Path, default=ROOT / 'downloads')
    parser.add_argument('--target-precision', type=float, default=.9)
    parser.add_argument('--min-validation-support', type=int, default=2)
    parser.add_argument('--include-examples', action='store_true', help='Include evaluation utterances in the exported report')
    args = parser.parse_args()
    args.data = args.data.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc)
    result = args.out / f'looma-intent-result-{stamp:%Y%m%dT%H%M%S%fZ}.zip'
    with tempfile.TemporaryDirectory(prefix='.looma-training-', dir=args.out) as tmp:
        tmp = Path(tmp)
        subprocess.run([sys.executable, str(ROOT/'train.py'), 'train', '--data', str(args.data), '--out', str(tmp),
                        '--target-precision', str(args.target_precision), '--min-validation-support', str(args.min_validation_support)], check=True)
        model_path = tmp/'model.json'
        model = json.loads(model_path.read_text(encoding='utf-8'))
        metrics_path = tmp/'metrics.json'
        report = json.loads(metrics_path.read_text(encoding='utf-8'))
        inputs = ['train.jsonl', 'validation.jsonl', 'test.jsonl']
        challenge = args.data/'challenge.jsonl'
        if challenge.is_file():
            splits = read_splits(args.data)
            rows = [json.loads(line) for line in challenge.read_text(encoding='utf-8').splitlines() if line.strip()]
            seen = {normalized(r['text']) for split in splits.values() for r in split}
            groups = {r['group'] for split in splits.values() for r in split}
            for row in rows:
                key = normalized(row['text'])
                if not key or key in seen or not row['group'] or row['group'] in groups or row['intent'] not in LABELS:
                    raise ValueError('challenge.jsonl has a duplicate, group overlap, or invalid label')
                seen.add(key)
            if not rows:
                raise ValueError('challenge.jsonl is empty')
            report['challenge'] = evaluate(model, rows)
            inputs.append('challenge.jsonl')
        if not args.include_examples:
            for split in ('validation', 'test', 'challenge'):
                if split in report:
                    for row in report[split]['examples']:
                        row.pop('text', None)
        metrics_path.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        manifest = {'format': 'looma-intent-training-result-v1', 'trained_at_utc': stamp.isoformat(),
                    'python': sys.version.split()[0], 'include_evaluation_text': args.include_examples,
                    'target_validation_precision': args.target_precision, 'min_validation_support': args.min_validation_support,
                    'trainer_sha256': sha256(ROOT/'train.py'), 'dataset_sha256': {n:sha256(args.data/n) for n in inputs},
                    'files_sha256': {p.name:sha256(p) for p in (model_path, metrics_path)}}
        pending = tmp/'result.zip'
        with zipfile.ZipFile(pending, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(model_path, model_path.name)
            archive.write(metrics_path, metrics_path.name)
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
        with zipfile.ZipFile(pending) as archive:
            if archive.testzip() is not None:
                raise OSError('Result archive failed integrity check')
        pending.replace(result)
    print(f'\nDownload this ZIP: {result.resolve()}', flush=True)


if __name__ == '__main__':
    main()
