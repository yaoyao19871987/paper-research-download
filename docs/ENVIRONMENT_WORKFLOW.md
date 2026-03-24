# 环境与操作流程

这个项目现在开始按 `dev`、`test`、`prod` 三种环境区分运行。

## 这三种环境分别做什么

- `dev`
  - 用来改代码、调试页面、试选择器。
  - 允许失败，重点是定位问题。
- `test`
  - 用来验证“这次修改能不能稳定跑通”。
  - 必须和正式产物目录分开。
- `prod`
  - 用来真正下载和交付结果。
  - 不建议边改代码边跑。

## 先做一次初始化

在项目根目录执行：

```powershell
Copy-Item .env.example .env
Copy-Item .env.dev.example .env.dev
Copy-Item .env.test.example .env.test
Copy-Item .env.prod.example .env.prod
```

然后把真实账号、密码这类共享信息填到 `.env`。

环境相关的目录配置放在：

- `.env.dev`
- `.env.test`
- `.env.prod`

## 现在推荐的日常流程

### 1. 改代码时先跑 `test`

```powershell
npm run pipeline:test -- --topic "你的测试主题"
```

这会把状态和产物写到：

- `downloads/test`
- `state/test`
- `python-scraper/cnkiLRspider/outputs/test`
- `work-reports/test`

### 2. 测试通过后再跑 `prod`

```powershell
npm run pipeline:prod -- --topic "正式主题"
```

这会把正式产物写到：

- `downloads/prod`
- `state/prod`
- `python-scraper/cnkiLRspider/outputs/prod`
- `work-reports/prod`

### 3. 需要手动看页面时，用测试环境开 UI

```powershell
npm run ui:test
```

## 你以后只需要记住的一条原则

不要再拿正式运行产生的登录状态、下载文件、输出记录，直接给测试复用。

最少要保证下面几项按环境分开：

- 登录状态 `AUTH_STATE_PATH`
- 下载目录 `DOWNLOAD_DIR`
- 搜索输出目录 `CNKI_OUTPUT_ROOT`
- 工作报告目录 `WORK_REPORT_DIR`

## 如果测试又出小问题，先这样判断

1. 看是不是只出现在 `test`，`prod` 没动过。
2. 看 `state/test` 里的登录状态是不是过期了。
3. 看 `outputs/test` 是否是旧运行目录被恢复了。
4. 确认不是上一次测试残留文件影响本次判断。

如果要更稳，下一步可以继续补两类东西：

- 真正的冒烟测试脚本
- 选择器检查和页面可用性检查
