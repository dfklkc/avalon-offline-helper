# 部署指南

本文档以原生微信小程序和 CloudBase 文档型数据库为准。操作前请确认微信开发者工具已更新到稳定版。

当前受支持的部署路径是微信开发者工具。代码的静态检查和测试需要本地 Node.js 18 或更高版本；云函数实际 Node.js 运行时由 CloudBase 控制台中的环境配置决定，部署前应确认它仍支持本项目使用的 CommonJS 和 Node `crypto` API。

> **计费说明（核对日期：2026-08-23）：**免费体验环境是开发/内测资源，不是永久免费的生产服务。小程序发布上线后，免费环境到期时间会变为上线后第 15 天。正式发布前应转为合适的付费套餐，并在 [CloudBase 资源点价格文档](https://cloud.tencent.com/document/product/876/127357) 复核最新价格与规则。

## 1. 下载并导入项目

1. 下载或克隆本仓库。
2. 打开微信开发者工具，选择“导入项目”。
3. 项目目录选择仓库根目录，而不是 `miniprogram` 子目录；工具会从 `project.config.json` 读取小程序和云函数根目录。
4. 首次导入可以先使用仓库内的 `touristappid` 检查静态界面，云端多人功能必须换成真实 AppID。

## 2. 获取小程序 AppID

1. 在微信公众平台注册“小程序”。
2. 使用管理员身份登录，在开发设置中复制 AppID。
3. 在 [`project.config.json`](../project.config.json) 中替换：

```json
{
  "appid": "wx你的真实AppID"
}
```

仓库默认的 `touristappid` 只能用于界面预览，不能用于真实 CloudBase 身份和多人测试。

## 3. 创建并关联 CloudBase 环境

推荐使用与小程序关联的腾讯云主账号，在 CloudBase 控制台创建当前资源点计费环境：

1. 选择上海地域。
2. 数据库类型选择**文档型数据库**。
3. 如账号符合条件，开发阶段可选免费体验版。
4. 记录完整环境 ID，例如 `cloud1-1gabcdef12345678`。
5. 在环境设置/安全设置中，把第 2 步的 AppID 关联到该环境。

如果环境是从腾讯云控制台创建、但微信开发者工具中没有显示，进入：

```text
云开发 → 设置 → 环境设置 → 管理我的环境 → 使用已有腾讯云环境
```

账号关联和导入流程见 [CloudBase 账号相关问题](https://cloud.tencent.com/document/product/876/57380)。

## 4. 在小程序中填入环境 ID

打开 `miniprogram/config/index.js`，将 `CLOUD_ENV` 替换为第 3 步的完整环境 ID：

```js
module.exports = Object.freeze({
  CLOUD_ENV: 'cloud1-1gabcdef12345678',
  GAME_API_FUNCTION: 'gameApi',
  POLL_INTERVAL_MS: 5000,
  POLL_MAX_DELAY_MS: 30000
})
```

`miniprogram/app.js` 会在 `CLOUD_ENV` 非空时把它传给 `wx.cloud.init`；留空时则使用微信开发者工具当前选中的云环境。建议真机体验版和发布构建显式填写环境 ID，避免因开发者工具选择错误而连到其他环境。

不要把测试环境 ID 与生产环境 ID 混用。云函数内部使用 `cloud.DYNAMIC_CURRENT_ENV`，所以它会访问实际部署所在的环境；小程序初始化环境和函数部署环境必须相同。

官方初始化示例见 [CloudBase 快速开始](https://cloud.tencent.com/document/product/876/121103)。

## 5. 创建数据库集合和权限

在云开发控制台打开“数据库”，创建两个集合：

```text
rooms
room_secrets
```

对每个集合执行相同的权限设置：

1. 打开集合的“权限设置”。
2. 选择**仅管理端可读写**。
3. 保存并再次进入页面确认设置已生效。

请勿选择“所有用户可读”或“仅创建者可读写”：

- 当前客户端不应直接读数据库；
- 云函数在服务端创建的记录不会自动拥有小程序客户端的 `_openid`；
- “仅创建者”不是该架构所需的安全模型。

当前架构不需要为 `watch` 放开任何读权限。客户端手工执行以下调用应被拒绝，这是正常且必须的：

```js
wx.cloud.database().collection('rooms').get()
wx.cloud.database().collection('room_secrets').get()
```

数据库权限原理见 [CloudBase 数据库概述](https://cloud.tencent.com/document/product/876/19369) 和 [安全规则](https://cloud.tencent.com/document/product/876/41802)。

无需手工创建文档或数据库索引。`gameApi` 会在建房时以 6 位房间码为文档 ID，同时创建两份房间文档。

## 6. 部署 `gameApi`

1. 在微信开发者工具顶部确认当前云环境。
2. 在文件树中找到 `cloudfunctions/gameApi`。
3. 右键目录，选择“上传并部署：云端安装依赖”。
4. 等待上传完成，在云开发控制台的云函数列表中确认函数名精确为 `gameApi`。
5. 打开函数日志，确认没有依赖安装错误。

不要为该函数添加 HTTP 触发器。它依赖小程序事件调用注入的 OpenID，应保持为小程序专用入口。云函数调用与部署参考 [在微信小程序中调用 CloudBase 云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)。

## 7. 本地检查与首次编译

先在项目根目录运行：

```bash
npm test
npm run check
```

然后在微信开发者工具中点击“编译”，至少完成：

1. 创建一个房间；
2. 用另一个真实微信账号加入；
3. 观察另一端在 5 秒左右更新；
4. 在云函数日志中确认请求到达 `gameApi`；
5. 确认日志中未输出整份角色分配或原始选票。

完整验收见 [多人手工测试](./manual-test.md)。

## 8. 上传、审核和发布

1. 在微信开发者工具上传小程序代码。
2. 在微信公众平台将对应版本设为体验版，完成 5–10 个真实微信账号的测试。
3. 检查小程序隐私保护指引、服务类目、用户昵称/头像等实际使用的接口是否已如实声明。
4. **在正式发布前处理 CloudBase 套餐。**不要把免费体验环境当作永久免费生产环境。
5. 为测试和生产分别使用独立环境，配置套餐用量与到期提醒，并记录当前可回滚的代码版本和云函数部署版本。
6. 如需备份，必须限制备份访问权限并设置保留期；`room_secrets` 含角色和私人备注，不能作为普通调试附件分享。
7. 当前代码没有自动 TTL。上线前应制定过期房间的清理周期，始终成对删除相同房间码的 `rooms` 和 `room_secrets` 文档。
8. 提交审核，通过后再发布。

当前没有调用微信昵称或头像接口；昵称由玩家自行输入。隐私保护指引应如实列出 OpenID、玩家自填昵称、角色、选票、私人备注和时间戳，并说明 CloudBase 环境管理员的访问边界。详见 [隐私与数据说明](../PRIVACY.md)。

免费环境到期后会先停服并进入隔离期，超过隔离期数据会被清除且不可恢复。具体以 [CloudBase 套餐及资源包说明](https://cloud.tencent.com/document/product/876/136006) 为准。

## 常见问题

### 提示 `invalid env` 或“非法的 env”

逐项检查：

- `wx.cloud.init` 的环境 ID 是否完整；
- `gameApi` 是否部署在同一环境；
- 当前 AppID 是否已关联到该环境；
- 微信开发者工具登录账号是否有该环境的权限。

### 提示 `function not exists`

确认云函数名大小写为 `gameApi`，并使用“云端安装依赖”重新上传。本地存在目录不代表云端已部署。

### 直接数据库请求报权限错误

如果请求来自小程序客户端，这是预期结果。当前实现必须调用 `gameApi`，不要放开 `rooms` 或 `room_secrets` 的客户端权限。

### 免费环境函数超时

截至 2026-08-23，免费体验版云函数最长 3 秒且不可修改。首先检查是否有无界查询、重复读写或外部网络请求；如业务确实需要更长时间，转为付费套餐。
