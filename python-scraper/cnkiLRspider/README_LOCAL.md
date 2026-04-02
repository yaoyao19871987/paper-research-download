# CNKI 检索子目录说明

这个目录只负责“选题研究、CNKI 检索、候选整理、导出下载队列”，不负责最终通过思学代理页落地下载文件。

如果你要跑完整端到端流程，优先从仓库根目录使用独立控制台：

```powershell
cd D:\Code\paper-download
npm run console
```

然后打开：

`http://127.0.0.1:8787`

当前主入口是：

- `research_pipeline.py`

辅助模块包括：

- `cnki_entry.py`
- `cnki_captcha.py`
- `cnki_common.py`
- `kimi_client.py`
- `generate_work_summary_report.py`

## 安装

```powershell
cd D:\Code\paper-download\python-scraper\cnkiLRspider
python -m pip install -r requirements.txt
```

## 选题文件

先复制模板，再改成你当前要跑的主题：

```powershell
Copy-Item .\topic.example.txt .\topic.txt
```

## 最常用运行方式

使用主题文件启动：

```powershell
python research_pipeline.py --topic-file .\topic.txt
```

恢复已有运行目录：

```powershell
python research_pipeline.py --topic-file .\topic.txt --resume-dir "D:\Code\paper-download\python-scraper\cnkiLRspider\outputs\<existing-run>"
```

自动批准检索策略：

```powershell
python research_pipeline.py --topic-file .\topic.txt --approve-strategy
```

在已有运行目录上自动批准下载候选：

```powershell
python research_pipeline.py --topic-file .\topic.txt --resume-dir "D:\Code\paper-download\python-scraper\cnkiLRspider\outputs\<existing-run>" --approve-selection
```

## 常用环境变量

```powershell
$env:CNKI_VERIFY_TIMEOUT = "600"
$env:CNKI_MAX_PAGES_PER_VIEW = "1"
$env:CNKI_MAP_BATCH_SIZE = "4"
$env:CNKI_DOWNLOAD_CANDIDATES = "15"
$env:EXPERT_MEETING_PAUSE_SECONDS = "1.5"
```

## 输出目录

每次运行会在下面生成一个独立目录：

`D:\Code\paper-download\python-scraper\cnkiLRspider\outputs\<topic>-<timestamp>\`

常见产物包括：

- `strategy_round1.json`
- `papers_master.csv`
- `papers_for_download.csv`
- `download_queue.csv`
- `run_status.json`
- `analysis_summary.md`

## 与根目录下载链路的关系

这里导出的 `papers_for_download.csv` / `download_queue.csv` 是给根目录 Node 下载链路消费的。

实际下载主入口在：

- `D:\Code\paper-download\src\legacy-sixue-download.js`
- `D:\Code\paper-download\src\pipeline-runner.js`
