# dsh-fetch-search 客制化节点：crawl4ai-docker

> 生成：2026-10-28。目标：把本机 Docker 里部署的 Crawl4AI 挂成 `dsh-fetch-search`
> 的客制化节点，并确保容器始终保持 started。

---

## 1. 结论速览

| 项 | 状态 |
|---|---|
| 客制化节点 `crawl4ai-docker` | ✅ 已注册并生效（桌面版 profile） |
| 抓取链路 | ✅ `crawl4ai-docker → tavily`（tavily 兜底） |
| 实测抓取 | ✅ `servedBy: crawl4ai-docker`，HTTP 200，953 字符，~1.2 s |
| 凭据 | ✅ `CRAWL4AI_API_KEY` = `dev-crawl4ai-token`（凭据库里**原本就有**，未改动） |
| Docker 重启策略 | ✅ 已由 `no` 修正为 `unless-stopped` |
| 看门狗（插件内置） | ✅ 已验证：容器被杀后 15 s 自愈（干净实验，排除一切其它可能） |

**关键认知**：这个插件**本来就有** Crawl4AI 原生适配器（`src/adapters/crawl4ai.ts`，
直连 `POST {baseURL}/md`），所谓「客制化节点」**不需要写新代码**——它是插件设置里的
**自定义服务商**条目（`customProviders`）。而且 `web` profile 里其实早就配好过一条
（`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`），只是**桌面版 profile 一直
指向 tavily**。

**本次实际工作 = 两件事**：

1. 把 `crawl4ai-docker` 这个客制化节点补到桌面版 profile（一条 YAML）。
2. 确认保活机制已就位：Docker 重启策略修正 + 插件内置看门狗自动接管。

> **不需要额外写看门狗**：插件自带的 `LocalStackManager`（`src/local-stack.ts`）已经
> 会在容器掉了之后自动 `docker start` 并持续轮询保活，登记本节点后它会自动接管。
> 中途曾评估过做一个独立 PowerShell 看门狗 + 计划任务，**结论是多余的，已回退**。

---

## 2. 客制化节点是怎么登记的

### 2.1 落点文件

```
C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
```

这是**桌面版 profile 的 patch 层**，也是插件配置的唯一真源。插件的 `Config` schema
（`src/settings.ts`）里每个字段都是 `.volatile()`，因此改这个文件会被 chokidar
监听到并**热重载**，无需重启 DSH（本次实测生效）。

### 2.2 当前内容

```yaml
- id: web-fetch-search
  name: dsh-fetch-search
  config:
    adapter: crawl4ai-docker          # 主服务商 = 客制化节点的 name
    fallback: tavily                  # 兜底
    baseURL: https://api.tavily.com
    apiKeyEnv: TAVILY_API_KEY
    maxFetchesPerSession: 10000
    proxy: https://127.0.0.1:13004
    proxyEnabled: false
    customProviders:
      - name: crawl4ai-docker         # ← 客制化节点
        adapter: crawl4ai              # ← 用原生 crawl4ai 适配器（不是契约 v1）
        baseURL: http://127.0.0.1:11235
        apiKeyEnv: CRAWL4AI_API_KEY
```

### 2.3 三个容易踩的坑

1. **`adapter` 填的是节点的 `name`，不是适配器 id。**
   `resolveProvider()`（`src/settings.ts:164`）先按内置 id 查表，而 `crawl4ai`
   **不在** `BASE_URL_BY_ADAPTER` / `KEY_ENV_BY_ADAPTER` 里，所以只能命中
   `customProviders` 里的同名条目。因此 `adapter: crawl4ai-docker` + 条目
   `name: crawl4ai-docker` 才是对的；写 `adapter: crawl4ai` 反而解析不到
   （`crawl4ai` 不是内置 id）。

2. **`apiKeyEnv` 必须指向凭据库里的真实引用名。**
   容器侧的环境变量叫 `CRAWL4AI_API_TOKEN`，插件侧引用的是 `CRAWL4AI_API_KEY`——
   **两个名字不一样**。本机凭据库里 `CRAWL4AI_API_KEY: dev-crawl4ai-token` 已存在，
   适配器取 key 时优先查凭据库（`credentials.resolve`），其次才看进程环境变量。
   留空也能工作（`resolveProvider` 对 crawl4ai 条目会回落到标准 ref `CRAWL4AI_API_KEY`），
   但显式写出来更清楚。

3. **loopback 端点不吃代理。**
   `provider.ts:275` 对 loopback URL 强制 `proxy: undefined`，即使
   `proxyEnabled: true` 也不会把本机流量绕到 `127.0.0.1:13004` 去。

### 2.4 界面里长什么样

插件卡片（DSH 设置 → 插件 → dsh-fetch-search → 「自定义服务商」区）会显示这一行。
想改节点，在卡片里增删改同一条目即可——卡片走 `form.set` → `ConfigEditor`，
底层同样是改同一个 patch 文件，**不要两边手改打架**。

---

## 3. 保活机制（两层，各管一段）

```
① Docker restart policy : unless-stopped → 扛住容器崩溃 / Docker 引擎 / 宿主机重启
② 插件内置看门狗        : src/local-stack.ts → DSH 开着时，20 s 轮询，容器掉了就 docker start
```

**不需要第三层**。插件自带的看门狗已覆盖日常场景，而 ① 覆盖了 DSH 关着的时候。

### 3.1 ① Docker 重启策略（已修正）

原值是 `no`——容器一崩或 Docker Desktop 一重启就再也不起来了。

```powershell
docker update --restart=unless-stopped crawl4ai
```

已生效，现值 `unless-stopped`。语义提醒：**手动 `docker stop` 之后不会被 Docker
自动拉起**（这正是 `unless-stopped` 与 `always` 的区别）。但此时插件内置看门狗会
在 20 s 内把它 `docker start` 起来——因为它判定「端口不通就 start」。

回退成原状只需：`docker update --restart=no crawl4ai`。

### 3.2 ② 插件内置看门狗（已验证，无需额外实现）

`src/local-stack.ts` 的 `LocalStackManager` 是插件自带的保活机制：

- **接管条件**（`needsContainer()`）：路由里引用了该条目 + 是 loopback +
  `adapter === 'crawl4ai'` + 端口是 11235。本次登记的节点**四项全中**，所以自动接管。
- **行为**：每 20 s 轮询一次 11235 端口；容器不在就 `docker start crawl4ai`，
  容器没了就 `docker run -d -p 127.0.0.1:11235:11235 --name crawl4ai
  --shm-size=1g -e CRAWL4AI_API_TOKEN=... unclecode/crawl4ai:latest`。
- **触发时机**：插件启动时 `stack.sync()`，以及每次配置热更新（`loader/volatile-update`）。
  也就是说**只要这个节点还在路由里，看门狗就一直在跑**。

**归属验证（做过一次干净实验）**：把 Docker 重启策略临时改成 `no`（让 Docker
自己完全不可能自愈）、确认没有任何外部看门狗脚本在跑，再 `docker kill crawl4ai` ——
容器仍在 **15 秒**内回到 `running`。施救者只可能是插件的 `LocalStackManager`。

> **边界**：这层依赖 DSH 进程活着。DSH 完全关闭期间，容器由 ① 兜底
> （容器崩溃 / Docker 引擎重启后自动拉起）；只有「DSH 关着 + 容器被手动 stop」
> 这个组合不会自动恢复——这种场景本来也不该自动恢复。

---

## 4. 验证记录

| # | 操作 | 结果 |
|---|---|---|
| 1 | `GET http://127.0.0.1:11235/`（不带 token） | 401（鉴权门开着，空 body） |
| 2 | `POST /md` + `Bearer dev-crawl4ai-token`，`{"url":"https://example.com","f":"fit"}` | 200，返回 `{url,filter,query,cache,markdown,success}`，`success=true`，markdown 1337 字符，~1.5 s |
| 3 | 改 profile patch 后查 `/api/fetch-third-party/chain` | `crawl4ai-docker → tavily`（**热重载，没重启 DSH**） |
| 4 | `POST /api/fetch-third-party/test` | `{"ok":true,"servedBy":"crawl4ai-docker","statusCode":200,"contentLength":953,"durationMs":1186}` |
| 5 | **干净实验**：重启策略临时设为 `no` + 无外部看门狗 + `docker kill crawl4ai` | **15 s** 恢复 ⇒ 唯一施救者是插件内置看门狗 |
| 6 | YAML 解析校验 | 15 行，`web-fetch-search` 条目字段与预期完全一致 |
| 7 | 容器 `docker events` 全程核对 | stop/kill/start 序列与上述结论一致 |

---

## 5. 本次实际改动清单

| 对象 | 改动 |
|---|---|
| `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` | `web-fetch-search` 行加 `customProviders`，`adapter` 改为 `crawl4ai-docker` |
| Docker 容器 `crawl4ai` | `RestartPolicy` 由 `no` 改为 `unless-stopped` |
| `C:\Users\<你>\.dsh\.credentials.yaml` | **未改动**（`CRAWL4AI_API_KEY` 原本就在） |
| `web` profile | **未改动**（原本就有同款节点） |
| 插件源码 | **未改动**（`src/**` 一行没动） |

**已回退的中间产物**：曾实现过一个独立 PowerShell 看门狗
（`scripts/crawl4ai-watchdog.ps1` + `scripts/start-crawl4ai-watchdog.ps1`）和 Windows
计划任务 `DSH-Crawl4AI-Watchdog`。结论是**与插件内置看门狗功能重复**，已全部删除、
计划任务已注销。

---

## 6. 遗留与提醒

- **宿主机 `com.docker.service` 是 Manual / Stopped**，靠 Docker Desktop 自身
  开机自启（`HKCU\...\Run` 有 `Docker Desktop`，`settings-store.json` 里
  `autoStart: true`）。也就是说容器要等 Docker Desktop 起来才可用。若要开机即用，
  需把 `com.docker.service` 改成 Automatic。
- **插件自建的容器没有重启策略**：`local-stack.ts` 里 `docker run` 那条命令
  **没带** `--restart unless-stopped`。也就是说——若容器被删除，插件会用
  `docker run` 重建一个**不带重启策略**的新容器，① 层就失效了。
  想彻底一致，可自行把 `src/local-stack.ts` 里那行 `docker run` 补上
  `--restart unless-stopped`（本次未改插件源码）。
- 遗留容器 `great_archimedes`（同镜像、已退出 2 个月、**未发布任何端口**）
  无害，不必处理；若想清爽可 `docker rm great_archimedes`。
- 插件卡片里改「自定义服务商」时，请不要同时手改 patch 文件——卡片和手改都会写
  同一个文件，会互相覆盖。
- 抓取内容上限由 `maxContentChars` 控制（默认 100000 字符），超出会截断并标记。
- 单会话抓取次数上限 `maxFetchesPerSession`（当前 10000）。
- 改了 profile patch 后**不必重启 DSH**，改完等 1～2 秒热重载即可；可用
  `http://127.0.0.1:61353/api/fetch-third-party/chain` 确认链路已切换。

---

## 7. 常用命令速查

```powershell
# 看链路当前指向谁
(Invoke-WebRequest 'http://127.0.0.1:61353/api/fetch-third-party/chain' -UseBasicParsing).Content

# 跑一次真实抓取（不消耗会话预算）
(Invoke-WebRequest -Uri 'http://127.0.0.1:61353/api/fetch-third-party/test' `
  -Method POST -ContentType 'application/json' -Body '{"url":"https://example.com"}' `
  -UseBasicParsing).Content

# 容器状态 / 健康 / 重启策略
docker inspect crawl4ai --format 'Status={{.State.Status}} Health={{.State.Health.Status}} Restart={{.HostConfig.RestartPolicy.Name}}'

# 免鉴权健康端点
Invoke-WebRequest 'http://127.0.0.1:11235/health' -UseBasicParsing | Select-Object -ExpandProperty Content

# 手动拉起（正常不需要，插件会管）
docker start crawl4ai
```
