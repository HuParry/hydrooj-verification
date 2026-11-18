# 开发与 npm 发布

将本目录作为独立仓库的根目录上传到 `HuParry/hydrooj-verification`，保留隐藏的 `.github/` 目录。工作流与 `package.json` 中的仓库信息均按此地址配置；仓库名称或归属变化时需要一并修改。

## 本地检查

在插件根目录执行：

```sh
npm ci --workspaces=false
npm run check:publish --workspaces=false
```

测试使用独立的临时 MongoDB，不连接线上服务，也不发送真实邮件。首次运行时可能下载 MongoDB 测试二进制。

测试还会读取 Hydro 原生 i18n 实现和邮件模板。在 Hydro 源码的 `packages/hydrooj-verification` 中运行时会自动找到相邻源码；独立克隆时，先准备 Hydro 源码，再指定路径：

```sh
git clone https://github.com/hydro-dev/Hydro.git .hydro-source
git -C .hydro-source checkout 17f8ac3cef550283894279727b027b1798efee9b
HYDRO_SOURCE_DIR="$PWD/.hydro-source" npm run check:publish --workspaces=false
```

GitHub Actions 会自动获取上述固定版本的测试源码，无需安装或启动 Hydro。该源码目录、开发依赖、测试和工作流都不会打进 npm 发布包。

## 首次发布与认证

工作流使用 npm Trusted Publishing（OIDC），不需要在 GitHub 中保存 `NPM_TOKEN`。

如果 npm 上还没有这个包，先在插件根目录登录 npm 并手动发布首版：

```sh
npm login
npm publish --access public --workspaces=false
```

请先完成上面的测试与打包检查。首版沿用当前 `package.json` 的版本，不要再通过工作流重复发布同一版本。

然后在 npm 的 `hydrooj-verification` 包设置中添加 GitHub Actions 可信发布者：

| 设置 | 内容 |
|------|------|
| Organization or user | `HuParry` |
| Repository | `hydrooj-verification` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | 允许直接执行 `npm publish` |

配置方式及适用要求见 [npm 可信发布文档](https://docs.npmjs.com/trusted-publishers/)。尚未配置可信发布者时，仅上传代码不会自动获得 npm 发布权限。

## 后续自动发布

工作流只在推送 `v*` 标签时触发。先提交要发布的修改，再更新版本、推送提交和标签，例如：

```sh
npm version patch --workspaces=false
git push origin HEAD
git push origin --tags
```

`npm version` 需要在干净的独立 Git 仓库中执行，会更新 `package.json` 和 `package-lock.json` 并创建版本标签。

发布前，工作流会检查标签是否与包版本一致，例如 `v1.4.1` 必须对应 `1.4.1`，随后按锁文件安装依赖、运行完整测试和打包检查，全部通过后才发布。已经发布的 npm 版本不能覆盖；重试前需确认该版本是否已经发布成功。
