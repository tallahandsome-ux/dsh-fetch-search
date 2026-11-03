# SearXNG 侧前置配置

本插件的搜索适配器只负责「按 SearXNG 的 JSON API 说话」。实例本身有两项配置漏掉就会出现「插件装好了、搜索却 403 / 搜不出结果」，本文件是排查清单。

## 1. 打开 JSON 输出（最常见的坑）

SearXNG 默认只输出 HTML。`format=json` 在未启用时返回 **HTTP 403**（官方原文：*Requesting an unset format will return a 403 Forbidden error*）。

```yaml
# settings.yml
search:
  formats:
    - html
    - json
```

改完**重启实例**。插件的 403 文案会直接指向这一段，`format=csv` / `format=rss` 也会一起 403，可用来对照确认。

## 2. 放行程序化请求

SearXNG 默认开启 limiter / botdetection，程序化请求容易被 429 或 403：

```yaml
# settings.yml
server:
  limiter: false          # 自用最省事
# 或保留 limiter，把调用方 IP 加进 botdetection 的 pass_ip / 白名单
```

## 3. 端点可达性

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8888/search?q=test&format=json'
```

`200` = 可用；`403` = 第 1 或第 2 条没做；连不上 = 容器没起或端口不对。

容器内**出站**（SearXNG → 各引擎）与**入站**（DSH → SearXNG）是两条独立链路：入站通常直连 loopback，出站才需要考虑代理，且必须在 `settings.yml` 的 `outgoing.proxies` 里配（SearXNG 用 curl_cffi，不读 `HTTP_PROXY` 环境变量）。

## 4. 验活方式

- 插件卡片 / 桥接：`POST /api/fetch-third-party/search-test`，body `{"query":"..."}`，返回 `{ok, servedBy, count, top[], durationMs, error?}`。
- 直接看实例统计页 `/stats`：每引擎成功率与耗时。
- `docker logs <container> --tail 50`：逐引擎报错。

## 5. 冷启动与超时

引擎各 3s、并行聚合，但实例刚重启后的首个查询实测可达 18.5s（引擎热身 + 代理链路）。插件默认 `searchTimeoutSeconds: 20`，如果你的实例更慢可调高；把「首查慢」误判成故障是最容易踩的坑。
