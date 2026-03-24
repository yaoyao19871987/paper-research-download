# Changelog

## [2026-03-21] Legacy Sixue Downloader Modularization & Project Cleanup

- Added a dedicated legacy downloader module:
  - `D:\Code\paper-download\src\legacy-sixue-download.js`
- Restored the real old path:
  - `思学首页 -> 文献下载 -> 入口1 -> 检索1 -> 代理 CNKI -> 篇关摘 -> 结果 -> papermao cdown -> 下载`
- Added built-in human-like pauses before and after critical clicks to match the old stable operating rhythm.
- Split the legacy downloader into reusable session-level APIs:
  - `openLegacySixueSession`
  - `downloadOneFromLegacySixueSession`
  - `closeLegacySixueSession`
- Kept the search page alive after each paper download so the next paper can continue from the existing proxy CNKI page.
- Confirmed that Kimi-based captcha OCR remains isolated in:
  - `D:\Code\paper-download\src\library-captcha.js`
  and is consumed by:
  - `D:\Code\paper-download\src\library-auth.js`
- Refreshed project documentation for GitHub migration and local handoff:
  - root `README.md`
  - `.env.example`
  - `Chinese paper search\cnkiLRspider\README_LOCAL.md`
  - `docs\GITHUB_MIGRATION.md`
  - `.gitignore`

## [2026-03-21] CNKI Direct-Scrape & Chrome Debug Reuse

- Added direct detail-page enrichment for CNKI `kcms2/article/abstract` pages so the pipeline can supplement missing abstracts, authors, institutions, journal names, and years from the current UI.
- Preserved CNKI detail URL parameters such as `v`, `cid`, `articleid`, `uniplatform`, and `language` to avoid losing abstract-page access during URL normalization.
- Added resilient per-page detail enrichment in the research pipeline with failure isolation, so a single detail-page timeout no longer aborts the whole query batch.
- Defaulted Selenium browser startup to Chrome and added automatic debugger-port detection (`9222/9223/9333`) so the pipeline can attach to an already-open debug Chrome session.
- Added helper launch scripts for Chrome debug mode and pipeline attach mode:
  - `D:\Code\paper-download\start-cnki-chrome-debug.cmd`
  - `D:\Code\paper-download\run-cnki-pipeline-debug.cmd`
- Added a local usage note:
  - `D:\Code\paper-download\CHROME_DEBUG_使用说明.md`
  - `D:\Code\paper-download\今日修改记录-2026-03-21.md`

## [2026-03-20] Resilience & Human-in-the-Loop Safeguards

Code review + resilience improvements for browser disconnect, session expiry, and crawl interruption scenarios.

### Node.js 下载器

#### `src/live-session.js`
- **浏览器断连检测与重连**：每次命令执行前通过 `isPageAlive()` 探测浏览器状态，断连后提示用户选择重连或退出。重连时自动重建 browser/context/page 并恢复登录态。
- **Session 过期自动检测**：`goto` 和 `download` 命令执行后检查页面是否出现登录表单，若检测到过期则自动触发重登录流程（填充账号→人工验证码→确认）。
- **空闲超时提醒**：5 分钟无操作后在终端打印提醒，防止 session 静默过期。
- **浏览器资源清理**：`main()` 使用 `try/finally` 确保退出时一定关闭 browser，防止僵尸 Chromium 进程。
- **修复 `fill` 命令**：`split(" :: ")` 改为只拆分首次出现，防止文本内含 ` :: ` 时被截断。

#### `src/download-paper.js`
- **浏览器资源清理**：`main()` 使用 `try/finally` 确保 `browser.close()` 一定执行。
- **友好的断连错误提示**：区分 "Target closed" 类错误，给出明确的浏览器关闭提示。

### Python 研究管线

#### `Chinese paper search/cnkiLRspider/cnki_common.py`
- **翻页验证码防护**：`next_page()` 在执行前调用 `wait_for_verification_to_clear()`，CNKI 在翻页时弹出验证码不再导致超时崩溃，而是暂停等待人工完成。
- **提取验证码防护**：`extract_result_cards()` 同样增加验证码检测，防止提取数据时被拦截。

#### `Chinese paper search/cnkiLRspider/research_pipeline.py`
- **爬取进度检查点**：新增 `crawl_checkpoint.json`，记录已完成的 `round:query:view` 组合。中断恢复时自动跳过已完成的爬取段，避免重复请求和触发反爬。
- **WebDriver 断连恢复**：`_crawl_queries()` 捕获 `WebDriverException`，自动重建 Selenium driver 并从当前 query 重试。
- **安全整数转换**：新增 `_safe_int()` 替代 `_merge_record` 中的裸 `int()` 调用，防止 `cited_count`/`download_count` 含非数字内容时抛出 `ValueError`。
