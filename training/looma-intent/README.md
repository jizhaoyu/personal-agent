# Looma 中文口语意图训练包（CPU 基线）

Python 3.10+，仅标准库，无需 pip、GPU、联网或 API Key。字符 1–3 gram 多项式朴素贝叶斯；模型为 JSON。这是可运行的分类基线，不是大模型微调，不修改 Looma 或写入待办。

## Linux 云服务器

```bash
unzip looma-intent-training-v1.zip
cd looma-intent
python3 --version
python3 train.py train --data data --out artifacts --target-precision 0.90 --min-validation-support 2
python3 train.py predict --model artifacts/model.json --text '合同还没发，别标完成'
python3 train.py predict --model artifacts/model.json --text '明天下午三点提醒我寄文件'
```

无 unzip 时，用 `python3 -m zipfile -e looma-intent-training-v1.zip .` 解压。

## 输出

- `artifacts/model.json`：训练得到的词表、计数与拒判阈值。
- `artifacts/metrics.json`：验证集和测试集的原始 top-1、覆盖率、接受结果准确率、误判完成及逐样本结果。没有接受样本时，接受结果准确率为 `null`，不是 100%。
- 预测中的 `needs_review` 表示分数不足；产品中可先保存原文，并不意味着必须弹窗。`margin` 是排序分差，不是概率。`execution_authorized` 永远是 `false`，即使返回 `complete` 也不能直接改库。

## 扩充数据

`data/*.jsonl` 每行有 `text`、`intent`、`group`。八类标签为：`original_only` 原文/非操作、`capture` 明确记录、`reminder` 提醒、`suggest` 普通计划、`complete` 完成、`cancel` 取消、`change` 改期/改名、`review` 业务核对。

内置 144 训练、24 验证、32 测试，均为合成种子数据。同一原始场景、改写家族或完整会话应使用同一个 group 且只放进一个数据集。默认阈值只在验证集选择，测试集不参与训练和阈值选择。分组检查只能发现显式 group 重叠及规范化后的完全重复，不能检测所有语义近重复，需人工审阅。

这是小样本流程验证；0.90 是验证集阈值选择目标，不是测试集或真实用户准确率承诺。不要把同一句话换姓名的改写当作独立泛化证据。后续收集脱敏且经许可的真口语，独立保留新用户/新会话，再用实际最终事项状态验收。该包不提取多事项、不解析时间、不匹配对象；上线还需 Looma 本地规则、版本检查和真实 EXE/APK 回归。
