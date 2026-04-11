# GeekEZ Local API

Base URL: `http://127.0.0.1:17555`

说明:
- 这是本地 API，只监听 `127.0.0.1`
- 打开浏览器实例仍然需要图形桌面环境，不支持把无头远程环境当成正式使用方式

## Health

`GET /health`

返回应用名和版本。

## Profile List

`GET /profiles`

返回完整 profile 列表。

`POST /profiles`

创建 profile。常用字段:
- `name`
- `proxyStr`
- `savedProxyId`
- `remark`
- `tags`
- `startupUrls`
- `fingerprint`
- `headerPresetId`
- `extensionPaths`
- `useGlobalExtensions`
- `geoPermissionMode`
- `cameraPermissionMode`
- `microphonePermissionMode`
- `notificationPermissionMode`
- `preProxyOverride`
- `debugPort`
- `timezone`
- `city`
- `geolocation`
- `language`

## Saved Profile Proxies

`GET /saved-profile-proxies`

返回当前已保存主代理列表，字段包括:
- `id`
- `name`
- `proxyStr`
- `tags`
- `group`
- `notes`
- `enabled`
- `profilesCount`

`POST /saved-profile-proxies`

新增一个已保存代理。常用字段:
- `id`
- `name`
- `proxyStr`
- `tags`
- `group`
- `notes`
- `enabled`

`PUT /saved-profile-proxies`

用整表覆盖保存代理库。请求体示例:

```json
{
  "savedProfileProxies": [
    {
      "id": "us-res-1",
      "name": "US Residential 1",
      "proxyStr": "socks5://user:pass@host:port",
      "tags": ["us", "warmup"],
      "group": "warmup-us",
      "notes": "provider A / owner jack",
      "enabled": true
    }
  ]
}
```

说明:
- 保存前会做 `id` 去重和空值校验
- 若某个已绑定 saved proxy 的 `proxyStr` 被修改，会自动同步回写绑定 profile 的 fallback `proxyStr`

`GET /saved-profile-proxies/:savedProxyId`

返回单个已保存代理。

`PATCH /saved-profile-proxies/:savedProxyId`

更新单个已保存代理。支持字段:
- `name`
- `proxyStr`
- `tags`
- `group`
- `notes`
- `enabled`

说明:
- 当前不支持通过 `PATCH` 修改 `id`

`DELETE /saved-profile-proxies/:savedProxyId`

删除单个已保存代理。

`GET /saved-profile-proxies/:savedProxyId/proxy-test`

读取该已保存代理最近一次检测结果；若尚未检测，返回 `status=info` 与 `summary=Not tested yet`。

`POST /saved-profile-proxies/:savedProxyId/proxy-test`

执行一次该已保存代理的独立连通性检测，不启动浏览器 profile。

返回字段包括：
- `success`
- `status`
- `mode`
- `direct`
- `proxyType`
- `checkedAt`
- `latencyMs`
- `checkedUrl`
- `statusCode`
- `ip`
- `country`
- `region`
- `city`
- `timezone`
- `postal`
- `org`
- `asn`
- `source`
- `proxySource`
- `savedProxyId`
- `savedProxyName`
- `proxySnapshot`
- `lastSuccessAt`
- `lastFailureAt`
- `failureStreak`
- `summary`
- `error`

`POST /profiles/batch/saved-proxy-binding`

批量绑定 / 替换 / 解除已保存代理绑定。请求体示例:

```json
{
  "profileIds": ["profile-a", "profile-b"],
  "savedProxyId": "us-res-1",
  "sourceSavedProxyId": "old-us-proxy",
  "syncFallbackProxyStr": true
}
```

或解除绑定:

```json
{
  "profileIds": ["profile-a", "profile-b"],
  "clear": true,
  "syncFallbackProxyStr": true
}
```

说明:
- `profileIds` 必填
- `savedProxyId` 用于批量绑定目标代理
- `sourceSavedProxyId` 可选；提供后只处理当前绑定该 saved proxy 的 profiles，可用于“批量替换 A -> B”
- `clear=true` 时解除 saved proxy 绑定
- `syncFallbackProxyStr=true` 时，同步更新 profile 内持久化的 `proxyStr`

`POST /profiles/batch/random-saved-proxy-binding`

为一批 profile 从已保存代理库中随机/按低使用量分配代理。请求体示例:

```json
{
  "profileIds": ["profile-a", "profile-b"],
  "tag": "us",
  "group": "warmup-us",
  "strategy": "least-used",
  "syncFallbackProxyStr": true
}
```

说明:
- `tag` 可选；提供后只从带该 tag 的 enabled saved proxies 中选择
- `group` 可选；提供后只从该分组下的 enabled saved proxies 中选择
- `strategy=random|least-used`
- `syncFallbackProxyStr=true` 时，同步更新 profile 内持久化的 `proxyStr`

## Saved Profile Proxy Sources

`GET /saved-profile-proxy-sources`

返回当前 source 列表，字段包括:
- `id`
- `name`
- `url`
- `enabled`
- `format`
- `stalePolicy`
- `scheduleEnabled`
- `scheduleIntervalMinutes`
- `autoQuarantineOnRefresh`
- `autoRecheckQuarantinedOnRefresh`
- `linkedProxyCount`
- `staleLinkedCount`
- `healthOkCount`
- `healthWarnCount`
- `healthCandidateCount`
- `healthUntestedCount`
- `healthStaleCount`
- `healthQuarantinedCount`
- `lastSync*`
- `syncHistory`
- `lastMaintenance*`
- `maintenanceHistory`

说明:
- `healthOkCount` 表示已检测通过或非失败信息态的代理数量
- `healthWarnCount` 表示检测失败、但尚未达到 quarantine 阈值的代理数量
- `healthCandidateCount` 表示已达到 quarantine 阈值、但当前尚未被禁用的代理数量
- `healthUntestedCount` 表示尚未检测的代理数量
- `healthStaleCount` 表示来源已失效或代理内容变更的代理数量
- `healthQuarantinedCount` 表示已达到 quarantine 阈值且已被禁用的代理数量
- `scheduleEnabled + scheduleIntervalMinutes` 控制后台定时维护
- `lastMaintenance*` 表示最近一次自动/手动维护结果摘要
- `maintenanceHistory` 最多保留最近 10 次维护摘要（`ranAt/status/trigger/quarantinedCount/recoveredCount/candidateCountAfter/quarantinedCountAfter/error`）

`POST /saved-profile-proxy-sources`

新增一个 source。常用字段:
- `id`
- `name`
- `url`
- `enabled`
- `format`
- `stalePolicy`
- `prefix`
- `startIndex`
- `group`
- `tags`
- `autoCheck`
- `scheduleEnabled`
- `scheduleIntervalMinutes`
- `autoQuarantineOnRefresh`
- `autoRecheckQuarantinedOnRefresh`

`GET /saved-profile-proxy-sources/:sourceId`

返回单个 source 详情。

`PATCH /saved-profile-proxy-sources/:sourceId`

更新单个 source。支持字段:
- `name`
- `url`
- `enabled`
- `format`
- `stalePolicy`
- `prefix`
- `startIndex`
- `group`
- `tags`
- `autoCheck`
- `scheduleEnabled`
- `scheduleIntervalMinutes`
- `autoQuarantineOnRefresh`
- `autoRecheckQuarantinedOnRefresh`

说明:
- 当前不支持通过 `PATCH` 修改 `id`

`DELETE /saved-profile-proxy-sources/:sourceId`

删除 source 配置本身，不会删除已导入代理；原代理会变成 `source-missing` 状态。

`POST /saved-profile-proxy-sources/:sourceId/refresh`

执行一次 source 刷新。返回字段包括:
- `source`
- `importResult`
- `sourceSyncResult`
- `policyResult`
- `autoCheckResult`
- `remote`

说明:
- `stalePolicy=mark|disable|detach`
- 刷新失败不会删除已有代理，只会写入本次错误摘要
- `syncHistory` 最多保留最近 10 条

`GET /saved-profile-proxy-sources/:sourceId/export?scope=all|stale&format=txt|json`

导出该 source 下代理:
- `format=txt` 时返回 `text/plain`
- `format=json` 时返回:

```json
{
  "source": {},
  "scope": "all",
  "count": 3,
  "proxies": []
}
```

`GET /saved-profile-proxy-sources/actions/history`

返回最近批量动作历史（最多 10 条），字段包括：
- `action`
- `finishedAt`
- `total`
- `ok`
- `failed`
- `added`
- `quarantined`
- `recovered`
- `dueCount`
- `overdueCount`
- `errorCount`
- `candidateCount`
- `sourceCount`
- `affectedProfilesCount`
- `sourceIds`

其中 `action` 可能为：
- `attention-maintenance`
- `refresh-due`
- `quarantine-candidates`
- `recheck-quarantined`

`POST /saved-profile-proxy-sources/actions/attention-maintenance`

执行总览级告警维护，使用**已保存配置**自动挑选需要关注的 source：
- due / overdue
- last maintenance error
- 存在 quarantine candidate

返回字段包括：
- `action`
- `total`
- `ok`
- `failed`
- `added`
- `quarantined`
- `recovered`
- `dueCount`
- `overdueCount`
- `errorCount`
- `candidateCount`
- `sourceCount`
- `sourceIds`
- `failures`
- `historyEntry`

`POST /saved-profile-proxy-sources/actions/refresh-due`

执行总览级“刷新到期来源”动作。返回字段包括：
- `action`
- `total`
- `ok`
- `failed`
- `added`
- `duplicateCount`
- `linkedCount`
- `staleCount`
- `reactivatedCount`
- `invalidCount`
- `policyAffectedCount`
- `sourceCount`
- `sourceIds`
- `failures`
- `historyEntry`

`POST /saved-profile-proxy-sources/actions/quarantine-candidates`

执行总览级“隔离候选代理”动作。返回字段包括：
- `action`
- `count`
- `total`
- `ok`
- `failed`
- `quarantined`
- `candidateCount`
- `sourceCount`
- `affectedProfilesCount`
- `sourceIds`
- `historyEntry`

`POST /saved-profile-proxy-sources/actions/recheck-quarantined`

执行总览级“复检隔离代理”动作。返回字段包括：
- `action`
- `total`
- `failed`
- `recoveredCount`
- `results`
- `sourceCount`
- `sourceIds`
- `historyEntry`

`POST /saved-profile-proxy-sources/:sourceId/actions/disable-stale`

禁用该 source 下所有 stale 代理。

`POST /saved-profile-proxy-sources/:sourceId/actions/detach-stale`

解除该 source 下所有 stale 代理的 source 绑定，但保留代理条目。

`POST /saved-profile-proxy-sources/:sourceId/actions/delete-stale`

硬删除该 source 下所有 stale 代理。

`POST /saved-profile-proxy-sources/:sourceId/actions/retest-linked`

重测该 source 下所有关联代理，返回：
- `action`
- `source`
- `total`
- `failed`
- `results`

其中 `results[]` 额外包含：
- `savedProxyId`
- `savedProxyName`
- `success`
- `status`
- `checkedAt`
- `latencyMs`
- `summary`
- `error`
- `failureStreak`
- `candidate`
- `quarantined`

`POST /saved-profile-proxy-sources/:sourceId/actions/retest-stale`

仅重测该 source 下所有 stale 代理。

`POST /saved-profile-proxy-sources/:sourceId/actions/quarantine-failed`

把该 source 下达到 quarantine 阈值的代理禁用。当前阈值为连续失败 `>= 3` 次。返回：
- `action`
- `source`
- `count`
- `affectedProfilesCount`

`POST /saved-profile-proxy-sources/:sourceId/actions/recheck-quarantined`

重测该 source 下已隔离代理；若重测成功，会自动重新启用并返回：
- `action`
- `source`
- `total`
- `failed`
- `recoveredCount`
- `results`

`POST /saved-profile-proxy-sources/:sourceId/actions/run-maintenance`

执行一次完整维护链路：
- refresh source
- 按 source 配置可选执行 auto quarantine
- 按 source 配置可选执行 auto recheck quarantined

返回字段包括：
- `action`
- `trigger`
- `source`
- `refreshResult`
- `quarantineResult`
- `recheckResult`

说明：
- `source.lastMaintenance*` 为本次执行后的最新摘要
- `source.maintenanceHistory` 会追加本次记录，并只保留最近 10 条
- 每条维护记录会额外带上本次维护后的 `candidateCountAfter` 与 `quarantinedCountAfter`

## Single Profile

`GET /profiles/:profileId`

返回单个 profile。

`PATCH /profiles/:profileId`

更新字段:
- `name`
- `proxyStr`
- `savedProxyId`
- `remark`
- `tags`
- `startupUrls`
- `fingerprint`
- `headerPresetId`
- `extensionPaths`
- `useGlobalExtensions`
- `geoPermissionMode`
- `cameraPermissionMode`
- `microphonePermissionMode`
- `notificationPermissionMode`
- `debugPort`
- `preProxyOverride`
- `timezone`
- `city`
- `geolocation`
- `language`

`DELETE /profiles/:profileId`

删除 profile。

## Runtime

`POST /profiles/:profileId/open`

启动 profile。可选请求体:

```json
{
  "watermarkStyle": "enhanced"
}
```

`POST /profiles/:profileId/close`

关闭 profile。

`POST /profiles/:profileId/restart`

重启 profile（先关闭再启动）。返回 `202` 表示已调度执行。

`POST /profiles/:profileId/restart-ssh`

当当前 profile 使用 `ssh://` 代理时，重建本地 SSH 动态转发。

`GET /profiles/:profileId/runtime`

返回运行时状态，包含:
- `running`
- `ws`
- `http`
- `debugPort`
- `localPort`
- `sshLocalPort`
- `proxyType`
- `proxySource`
- `activeSavedProxyId`
- `activeSavedProxyName`
- `proxyBindingBroken`
- `canRestartSsh`
- `sshState`
- `sshLastError`
- `resolvedTimezone`
- `resolvedLanguage`
- `resolvedLanguages`
- `resolvedAcceptLanguage`
- `resolvedGeolocation`
- `resolvedCity`
- `resolvedCountry`
- `autoCalibrationError`
- `activeHeaderPresetId`
- `geoPermissionState`
- `cameraPermissionState`
- `microphonePermissionState`
- `notificationPermissionState`
- `permissionStates`
- `selfCheckSummary`

`GET /profiles/:profileId/ip`

通过当前实例代理出口查询公网 IP。

`GET /profiles/:profileId/netinfo`

查询出口网络信息，例如地区、时区、ASN。

`GET /profiles/:profileId/proxy-test`

读取当前 profile 最近一次代理测试结果；若尚未测试，返回 `status=info` 与 `summary=Not tested yet`。

`POST /profiles/:profileId/proxy-test`

执行一次代理测试：
- profile 正在运行时，直接复用当前实例代理链路
- profile 未运行时，临时建立独立代理链路做测试，不启动浏览器

返回字段包括：
- `success`
- `status`
- `mode`
- `direct`
- `running`
- `proxyType`
- `proxySource`
- `savedProxyId`
- `savedProxyName`
- `proxyBindingBroken`
- `proxySnapshot`
- `checkedAt`
- `latencyMs`
- `checkedUrl`
- `statusCode`
- `ip`
- `country`
- `region`
- `city`
- `timezone`
- `postal`
- `org`
- `asn`
- `source`
- `summary`
- `error`

## Diagnostics

`GET /profiles/:profileId/diagnostics`

返回 dashboard 检测工作台数据，包含:
- `presets`
- `recentRuns`
- `headerPreview`
- `expectedBrowser`
- `observedHeaders`
- `activeHeaderPresetId`
- `geoPermissionState`
- `permissionStates`
- `selfCheckSummary`

`recentRuns[]` 现在会尽量附带第三方站点采集结果:
- `comparison`
  - `previousOpenedAt`
  - `changed`
  - `changeCount`
  - `summary`
  - `changes[]`
    - `label`
    - `before`
    - `after`
    - `type`
- `result.status` = `ok|warn|info`
- `result.headline`
- `result.summary`
- `result.signals`
- `result.facts[]`
  - `label`
  - `value`
  - `status`
- `result.title`
- `result.finalUrl`
- `result.capturedAt`
- `result.artifacts.runId`
- `result.artifacts.available`
- `result.artifacts.screenshotUrl`
- `result.artifacts.htmlUrl`
- `result.artifacts.textUrl`
- `result.artifacts.jsonUrl`

`POST /profiles/:profileId/diagnostics/open`

请求体示例:

```json
{
  "presetId": "builtin-browserleaks"
}
```

使用当前 profile 打开内置检测站，并记录 recent runs。

`POST /profiles/:profileId/diagnostics/run-all`

按当前启用顺序依次打开全部内置/自定义检测预设，并刷新 recent runs。

`POST /profiles/:profileId/diagnostics/clear`

清空当前 profile 的 `recentRuns`，并删除对应 `diagnostic-artifacts` 归档目录。

`GET /profiles/:profileId/diagnostics/artifacts/:runId/:kind`

- `kind` = `screenshot|html|text|json`
- 返回该次 recent run 的归档文件
- `screenshot` 返回 `image/png`
- `json` 返回结构化快照（页面采样 + 解析结果）
- `html` / `text` 返回纯文本

`GET /diagnostics/accept-ch/bootstrap`

dashboard 内部探针入口。返回 `Accept-CH` 响应头，向当前本地 origin 申请高熵 Client Hints。

`GET /diagnostics/accept-ch/collect`

dashboard 内部探针采集入口。回显当前请求携带的 Client Hints 请求头，用于本地 self-check。

## Cookies

`POST /profiles/:profileId/cookies/import`

请求体示例:

```json
{
  "content": "cookie text / json / netscape",
  "targetUrl": "https://example.com"
}
```

说明:
- 支持 `JSON` / `Netscape` / `name=value` 文本
- 当文本 cookies 未提供 domain/url 时，优先使用 `targetUrl`，否则回退到 `startupUrls[0]`
- 导入前请先关闭该 profile

`GET /profiles/:profileId/cookies/export?format=json|netscape`

导出当前 profile 的 cookies。
