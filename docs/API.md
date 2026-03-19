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
- `remark`
- `tags`
- `fingerprint`
- `preProxyOverride`
- `debugPort`
- `timezone`
- `city`
- `geolocation`
- `language`

## Single Profile

`GET /profiles/:profileId`

返回单个 profile。

`PATCH /profiles/:profileId`

更新字段:
- `name`
- `proxyStr`
- `remark`
- `tags`
- `fingerprint`
- `debugPort`
- `preProxyOverride`

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
- `canRestartSsh`
- `sshState`
- `sshLastError`

`GET /profiles/:profileId/ip`

通过当前实例代理出口查询公网 IP。

`GET /profiles/:profileId/netinfo`

查询出口网络信息，例如地区、时区、ASN。
