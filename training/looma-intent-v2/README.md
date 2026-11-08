# Looma 中文口语意图训练包 v2

Python 3.10+，仅标准库，CPU 即可。v2 沿用 v1 的字符 n-gram 朴素贝叶斯模型，新增 48 条人工编写的合成训练反例，未使用截图原句训练。原来的 32 条测试句保留为回归集；另有 32 条新编挑战样本，未用于训练或选择阈值，但仍是小样本合成数据。

```bash
python3 -m zipfile -e looma-intent-training-v2.zip .
cd looma-intent-v2
python3 train.py train --data data --out artifacts
python3 train.py predict --model artifacts/model.json --text '老陈那个合同我还没发，先别关掉'
```

`artifacts/model.json` 是模型，`artifacts/metrics.json` 包含原 32 条回归句的逐条结果。`comparison.json` 是打包前的 v1/v2 对比，`data/challenge.jsonl` 是对应挑战集。新挑战集：首选答对 v1 24/32、v2 29/32；接受预测 v1 14 条中 11 条正确、v2 17 条中 17 条正确。不接受的句子不会算作正确接受。合成测试不代表真实用户准确率。

预测为 `needs_review` 时，可以先保留原文、由 Looma 结合上下文进一步判断，不一定要弹窗。`execution_authorized` 永远是 `false`；这个包不修改 Looma，不创建、改期、取消或完成待办，也不微调任何大模型。标签和分组说明见 `README-v1.md`。
