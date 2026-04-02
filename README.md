# paper-download

一个围绕 CNKI 选题检索与思学图书馆代理下载的自动化仓库。

当前保留两条主链路：

1. `python-scraper/cnkiLRspider`
   - 负责选题分析、检索策略生成、CNKI 检索、候选论文整理、导出下载队列。
2. `src`
   - 负责图书馆登录态复用、验证码处理、代理 CNKI 页面跳转和实际下载。

仓库已经按“当前主流程可维护”做过一次清理。旧版调试入口、历史说明文档和阶段性记录已移除，保留的是现在还在用的主代码和运行所需配置模板。

## 目录结构

```text
paper-download/
├─ config/
│  └─ selectors.example.json
├─ python-scraper/
│  └─ cnkiLRspider/
│     ├─ README_LOCAL.md
│     ├─ research_pipeline.py
│     ├─ cnki_entry.py
│     ├─ cnki_captcha.py
│     ├─ cnki_common.py
│     ├─ kimi_client.py
│     └─ generate_work_summary_report.py
├─ src/
│  ├─ build-heuristic-queue.js
│  ├─ common.js
│  ├─ legacy-sixue-download.js
│  ├─ library-auth.js
│  ├─ library-captcha.js
│  ├─ pipeline-runner.js
│  ├─ site-credential-vault.py
│  └─ site-credentials.js
├─ downloads/          # 已下载论文，默认不纳入 Git
├─ outputs/            # 截图、HTML、临时运行产物，默认不纳入 Git
├─ state/              # 登录态等本地状态，默认不纳入 Git
├─ work-reports/       # 运行总结与工作报告，默认不纳入 Git
├─ .env.example
├─ .env.dev.example
├─ .env.test.example
├─ .env.prod.example
├─ package.json
└─ README.md
```

## 安装

Node 侧：

```powershell
cd D:\Code\paper-download
npm install
```

Python 侧：

```powershell
cd D:\Code\paper-download\python-scraper\cnkiLRspider
python -m pip install -r requirements.txt
```

## 初始配置

1. 复制环境变量模板。

```powershell
Copy-Item .env.example .env
```

2. 复制选择器模板。

```powershell
Copy-Item .\config\selectors.example.json .\config\selectors.json
```

3. 复制选题模板。

```powershell
Copy-Item .\python-scraper\cnkiLRspider\topic.example.txt .\python-scraper\cnkiLRspider\topic.txt
```

4. 根据当前站点页面结构调整 `config/selectors.json`，并把实际选题写入 `python-scraper/cnkiLRspider/topic.txt`。

## 常用命令

单篇下载验证：

```powershell
npm run legacy-download
```

完整流水线：

```powershell
npm run pipeline
```

按环境运行：

```powershell
npm run pipeline:dev
npm run pipeline:test
npm run pipeline:prod
```

仅运行 Python 检索链路：

```powershell
cd D:\Code\paper-download\python-scraper\cnkiLRspider
python research_pipeline.py --topic-file .\topic.txt
```

## Git 约定

以下内容默认不纳入版本控制：

- `.env*`
- `config/selectors.json`
- `python-scraper/cnkiLRspider/topic.txt`
- `downloads/`
- `outputs/`
- `state/`
- `work-reports/`
- `python-scraper/cnkiLRspider/outputs/`

这意味着仓库提交时应只包含代码、配置模板和必要说明，不包含真实账号、登录态、下载产物和运行现场。

## 维护原则

- 以 `src/pipeline-runner.js` 和 `src/legacy-sixue-download.js` 作为当前 Node 主入口。
- 以 `python-scraper/cnkiLRspider/research_pipeline.py` 作为当前 Python 主入口。
- 新增流程说明时，优先更新本 README 或 `python-scraper/cnkiLRspider/README_LOCAL.md`，不要再堆阶段性纪要型文档。
- 已下载论文、运行日志和历史状态默认保留在本地，不作为这次仓库清理对象。
