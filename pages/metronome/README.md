# 节拍器

可以直接双击 `index.html`，也可以通过 HTTP 或 GitHub Pages 访问。

浏览器加载 `js/metronome.js` 普通脚本，避免本地 `file://` 对 ES 模块的跨域限制。源码保留为 `js/rhythm.js`、`js/audio.js` 和 `js/app.js`，便于独立维护和测试。

修改源码后，在本目录运行：

```sh
npm run build
npm test
```

构建不需要安装依赖。测试会检查浏览器脚本是否与源码一致，防止源码更新后页面仍加载旧版本。
