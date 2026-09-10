# mome Web Clipper

Chrome / Edge Manifest V3 扩展，用现有 mome API key 保存网页、选中文本和标签。

## 本地安装

1. 在 mome 的“设置 → API keys”创建一个 API key。
2. 打开浏览器扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展程序”，指向本目录。
4. 打开扩展设置，填写 mome 实例地址和 API key。

点击工具栏按钮可编辑后保存；网页或选中文本也可通过右键菜单快速保存。

## 权限说明

- 扩展不再申请全局站点权限（`<all_urls>`）；保存设置时会按需请求
  对目标 mome 实例的访问权限（`optional_host_permissions`）。
- 实例地址必须使用 HTTPS（本地 localhost / 127.0.0.1 调试除外），
  API key 不会通过明文 HTTP 传输。
- API key 明文保存在本机 `chrome.storage.local` 中，不会同步到其他设备。
