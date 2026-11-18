# 邮件验证入口审计

审计日期：2026-11-17。范围：当前本地 Hydro 源码，以及 `xian-server` 上 Hydro 5.1.0 核心与 `/root/.hydro/addon.json` 中已启用的插件。服务器扫描了 499 个 TypeScript、JavaScript、HTML 源文件，排除依赖目录、编译产物和静态资源。

| 用途 | 原生发信入口 | 原生邮件模板 | 插件接入方式 |
| --- | --- | --- | --- |
| 注册 | `UserRegisterHandler.post`，`packages/hydrooj/src/handler/user.ts` | `user_register_mail.html` | 替换注册发送逻辑；验证码通过后进入原生注册页 |
| 忘记密码或用户名 | `UserLostPassHandler.post`，同上 | `user_lostpass_mail.html` | 替换找回发送逻辑；验证码通过后进入原生密码重置页 |
| 更换邮箱 | `HomeSecurityHandler.postChangeMail`，`packages/hydrooj/src/handler/home.ts` | `user_changemail_mail.html` | 原生 sudo + 密码复核后发送验证码；通过后进入原生邮箱变更 handler |

这三类是当前核心中所有发送含验证长链接邮件的业务入口。已启用插件中未发现额外的同类发信入口。SMTP 底层仍使用 `packages/hydrooj/src/lib/mail.ts`；其内部 `transporter.sendMail()` 是统一传输层，不是第四类验证场景。OAuth 注册、TOTP、WebAuthn 的令牌或验证码不通过验证邮件发送，不纳入替换。

## 更换邮箱的身份约束

- 必须具有原生登录用户权限，并通过原生 `requireSudo`。
- 首次向一个新邮箱发码前复核当前密码；管理员代登录时复核实际操作者的密码，保持原生规则。
- 验证绑定当前账号 UID、原邮箱、管理员代登录身份、浏览器会话、域、新邮箱和 `changemail` 用途。
- 只有有效绑定的同一新邮箱重发才复用本次密码复核。更换目标邮箱或验证过期后需重新复核密码。
- 验证通过前不更改原邮箱。通过后重新检查占用情况和黑名单，再签发原生 `TYPE_CHANGEMAIL` 令牌，由 `UserChangemailWithCodeHandler` 执行实际变更。
- 验证码仍为 6 位数字、10 分钟有效、最多尝试 3 次；数据库原子限制和一次性消费适用于三个用途。

插件通过请求钩子接管发信，不修改 Hydro 核心及其旧模板。因此源码搜索仍能找到原生长链接模板；插件生效后的新验证邮件由上述三个验证码模板发送。既有邮件及已签发的原生令牌不做批量撤销，按原有有效期到期。

结论仅针对本次审计的版本与已启用插件；以后新增或更新插件时，需要重新检查发信入口。
