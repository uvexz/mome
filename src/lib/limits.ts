/**
 * 客户端与服务端共享的输入限制常量。
 * 必须放在无依赖的纯模块里：客户端组件直接 import 服务端模块会触发
 * import-protection（把 #/db 拖进浏览器包）。
 */
export const MAX_CONTENT = 5000
