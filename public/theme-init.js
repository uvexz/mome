// 防 FOUC：首帧前按 localStorage / 系统偏好设置 <html data-mode>
// 独立文件以便生产环境 CSP 使用 script-src 'self'（禁止内联脚本）
;(function () {
  try {
    var s = localStorage.getItem('mome-theme')
    var m =
      s === 'light' || s === 'dark'
        ? s
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    document.documentElement.setAttribute('data-mode', m)
  } catch (e) {
    document.documentElement.setAttribute('data-mode', 'light')
  }
})()
