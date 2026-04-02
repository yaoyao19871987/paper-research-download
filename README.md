# paper-research-download

一个面向中文学术资料采集场景的端到端自动化仓库：先做选题分析与 CNKI 检索，再整理候选文献，最后通过思学图书馆代理链路完成论文下载，并生成运行状态与工作总结。

这个项目目前以 Windows + PowerShell 为主要使用环境，核心能力分成两层：

- Python 检索层：负责选题扩展、检索策略、CNKI 抓取、候选文献整理
- Node 下载层：负责图书馆登录、验证码处理、代理页跳转、实际 PDF 下载

仓库还提供了一个本地独立控制台，方便不依赖聊天窗口直接完成预检、启动任务、恢复运行、查看日志和查看结果。

## 功能概览

- 围绕主题自动生成检索策略并分轮抓取 CNKI 候选文献
- 将候选文献导出为 `papers_for_download.csv` / `download_queue.csv`
- 复用图书馆代理登录态，自动处理验证码与下载跳转
- 支持自动模式和人工确认模式
- 记录端到端运行状态、日志、候选文件和下载结果
- 生成工作总结报告，便于回顾一次完整任务
- 提供本地控制台页面，支持“新任务 / 恢复任务 / 预检 / 日志查看”

## 核心流程

完整流程如下：

1. 输入研究主题
2. Python 侧生成检索策略并抓取 CNKI 结果
3. 整理候选文献并输出待下载队列
4. Node 侧登录图书馆代理并执行下载
5. 校验下载结果
6. 生成运行总结与工作报告

主入口链路：

1. `npm run pipeline`
2. [`src/pipeline-runner.js`](./src/pipeline-runner.js)
3. [`python-scraper/cnkiLRspider/research_pipeline.py`](./python-scraper/cnkiLRspider/research_pipeline.py)
4. [`src/legacy-sixue-download.js`](./src/legacy-sixue-download.js)

独立控制台入口链路：

1. `npm run console`
2. [`src/console-server.js`](./src/console-server.js)
3. [`src/run-manager.js`](./src/run-manager.js)
4. [`ui/index.html`](./ui/index.html)

## 目录结构

```text
paper-research-download/
├─ config/
│  ├─ selectors.example.json
│  └─ selectors.json                  # 本地站点选择器，不纳入 Git
├─ python-scraper/
│  └─ cnkiLRspider/
│     ├─ research_pipeline.py
│     ├─ cnki_common.py
│     ├─ kimi_client.py
│     ├─ kimi_image_ocr.py
│     ├─ generate_work_summary_report.py
│     └─ README_LOCAL.md
├─ src/
│  ├─ pipeline-runner.js
│  ├─ legacy-sixue-download.js
│  ├─ library-captcha.js
│  ├─ console-server.js
│  └─ run-manager.js
├─ ui/
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ downloads/                         # 默认不纳入 Git
├─ outputs/                           # 默认不纳入 Git
├─ state/                             # 默认不纳入 Git
├─ work-reports/                      # 默认不纳入 Git
├─ start-console.cmd
├─ package.json
└─ README.md
```

## 运行前准备

### 1. 安装依赖

Node 侧：

```powershell
cd paper-research-download
npm install
npx playwright install
```

Python 侧：

```powershell
cd paper-research-download\python-scraper\cnkiLRspider
python -m pip install -r requirements.txt
```

### 2. 复制本地配置模板

```powershell
cd paper-research-download
Copy-Item .env.example .env
Copy-Item .\config\selectors.example.json .\config\selectors.json
```

### 3. 填写必要配置

至少需要准备以下信息：

- 图书馆代理账号密码
- Kimi 可用凭据
- 与当前站点结构匹配的 `config/selectors.json`

相关模板文件：

- [`.env.example`](./.env.example)
- [`config/selectors.example.json`](./config/selectors.example.json)

## 推荐使用方式

### 方式一：独立控制台

这是目前最适合日常使用的入口。

启动：

```powershell
cd paper-research-download
npm run console
```

然后打开：

```text
http://127.0.0.1:8787
```

也可以直接双击：

[`start-console.cmd`](./start-console.cmd)

控制台支持：

- 运行预检
- 启动全新任务
- 恢复最近一次运行
- 恢复指定 `run_dir`
- 查看实时日志
- 查看关键输出文件
- 停止活动任务
- 向活动任务发送 `continue`

### 方式二：命令行主流程

完整流水线：

```powershell
cd paper-research-download
npm run pipeline -- --topic "魏晋石刻" --download-limit 15
```

恢复已有运行目录：

```powershell
npm run pipeline -- --resume-run ".\python-scraper\cnkiLRspider\outputs\<run-dir>" --download-limit 15
```

按环境运行：

```powershell
npm run pipeline:dev
npm run pipeline:test
npm run pipeline:prod
```

### 方式三：只跑 Python 检索链路

```powershell
cd paper-research-download\python-scraper\cnkiLRspider
python research_pipeline.py --topic-file .\topic.txt
```

子目录补充说明见：

[`python-scraper/cnkiLRspider/README_LOCAL.md`](./python-scraper/cnkiLRspider/README_LOCAL.md)

## 关键产物

每次完整运行都会在下面生成独立目录：

```text
python-scraper/cnkiLRspider/outputs/<topic>-pipeline-<timestamp>/
```

常见产物包括：

- `input_topic.txt`
- `strategy_round1.json`
- `papers_master.csv`
- `papers_selected.csv`
- `papers_for_download.csv`
- `download_queue.csv`
- `run_status.json`
- `pipeline_state.json`
- `pipeline_result.json`
- `analysis_summary.md`
- `work_summary_report.md`

控制台自身的状态和日志默认写到：

- `state/console-manager.json`
- `state/console-logs/`

## 常见问题

### 1. 为什么预检通过后仍然下载失败？

预检只能确认基础依赖、目录、凭据和配置是否存在，不能保证站点页面结构没有变化。若登录页、验证码区域或下载按钮结构变更，需要更新 `config/selectors.json`。

### 2. 为什么 `run_status.json` 和 `pipeline_state.json` 会同时存在？

`run_status.json` 主要兼容 Python 检索链路与旧观察方式，`pipeline_state.json` / `pipeline_result.json` 负责描述 Node 端到端主流程状态。当前仓库已经同步这两套状态文件，便于旧脚本和新控制台同时消费。

### 3. 运行产物为什么没有进入 Git？

这是刻意设计。下载文件、运行日志、工作报告、站点凭据和本地选择器都属于运行现场或敏感配置，应保留在本地，不应推送到公开仓库。

## Git 与安全约定

以下内容默认不纳入版本控制：

- `.env*`
- `config/selectors.json`
- `downloads/`
- `outputs/`
- `state/`
- `work-reports/`
- `python-scraper/cnkiLRspider/outputs/`

提交仓库时，应只包含代码、模板配置、说明文档和必要脚本，不包含：

- 真实账号密码
- 已登录状态
- 下载得到的 PDF
- 历史运行日志
- 运行中的临时截图或 HTML 快照

## 当前仓库定位

这个仓库现在更像一个“可运行的本地研究工作台”，而不是单一脚本集合：

- Python 侧负责研究与候选整理
- Node 侧负责下载执行与运行控制
- 控制台负责把现有流程包装成更稳定的本地操作界面

如果你要做下一步扩展，建议优先保持这条边界：

- 不重复实现第二套下载逻辑
- 不在 UI 中复制 Python / Node 核心流程
- 优先通过 `pipeline-runner.js` 和 `research_pipeline.py` 维护唯一主链路

## License

本项目采用 MIT License，详见 [`LICENSE`](./LICENSE)。
