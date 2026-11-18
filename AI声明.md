# 关于生成式人工智能参与的说明

## 一句话

本项目的**代码、测试、文档基本都由生成式 AI 生成**；仓库维护者**没有编程能力**，无法独立审查、判断或修复其中的问题。
请在理解这一点之后，再决定是否使用。

## 谁做了什么

| 环节 | 由谁完成 |
| --- | --- |
| 提出需求、定义工作流、试用并验收效果 | 维护者（人） |
| 写代码、写测试、写文档、排查错误、重构 | 生成式 AI（通过 DSH 在维护者本机执行） |
| 决定「保留 / 发布」 | 维护者按**功能是否可用**判断，不具备代码审查能力 |

## 这意味着什么

- 代码可能存在**错误、隐患、低效实现**。测试通过不等于正确——测试本身也是 AI 写的。
- **没有任何担保**，见下方「许可与责任」。
- 遇到问题，维护者**很可能无法自己修**，只能再次向 AI 描述现象；修复速度与正确性都不保证。
- 接口、配置项、默认值可能随版本变动，**没有兼容性承诺**。

## 使用前建议

1. **不要只在唯一副本上跑**：先备份，先在测试目录验证一遍。
2. 如果你也不具备编程能力：请一位有经验的开发者过一遍 server/ 与 lib/，重点看三处——
   - 它会**读写你本机文件**（音频、字幕、音色库、上传的 Word 文档）
   - 它会**启动本地 Python 进程**并加载模型、占用显存
   - 它会在 127.0.0.1 上开一个**没有鉴权的 HTTP 接口**
3. 用于生产环境或商业项目前，请自行做安全与合规评估。

## 它联网吗

- **日常使用不联网**：配音、字幕、对齐、翻译都在本机跑。
- **只有两步需要网络**：安装 Python 依赖、下载模型权重（约 18 GB，另加可选的翻译模型 2.5 GB）。

## 许可与责任

代码以 **MIT** 许可发布（见 LICENSE），**按「原样」提供，不附带任何明示或暗示的担保**，包括但不限于适销性、特定用途适用性与非侵权担保。
因使用本项目造成的任何直接或间接损失，作者不承担责任。

## 关于 issue 与 PR

欢迎提，但请预期：

- 回复可能很慢，甚至没有；
- 最终修复大概率仍由 AI 提出方案，维护者验证的是「功能是否恢复」，**而不是「代码是否正确」**。

---

## English summary

This project was written almost entirely by a generative AI (code, tests, documentation).
The repository owner **does not have programming ability** and cannot review, validate, or guarantee the code.
It is provided **"AS IS", without warranty of any kind**, under the MIT license.
Before relying on it, have a developer review it — especially the file I/O, the local Python process it spawns, and the unauthenticated HTTP endpoint it opens on 127.0.0.1.
