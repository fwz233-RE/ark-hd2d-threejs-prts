# Ark HD-2D Three.js 原型

这是一个纯 Three.js 的 HD-2D 场景：程序化地面、透视相机、AlphaTest 景深、接触阴影、四名干员和 Spine 3.8 模型转换出的透明分页帧图集。网页运行时只加载 Three.js 和本地帧图集，不依赖 Spine runtime 或远程 PRTS 请求。

## 在线体验

GitHub Pages 会在 `main` 分支更新后自动构建和部署：

**[打开在线场景](https://fwz233-re.github.io/ark-hd2d-threejs-prts/)**

> 首次打开需要等待角色帧图集加载完成。页面使用 Git LFS 存储大型 PNG 和 Spine 源文件。

![四人庭院全景](docs/images/courtyard.jpg)

![聚焦角色和动作控制](docs/images/operator-closeup.jpg)

## 启动

```bash
npm install
npm run dev
```

然后打开 Vite 输出的本地地址。资源不能通过 `file://` 直接打开，必须经过本地开发服务器。

操作方式：

- 左下角按钮或数字键 `1–4`：切换当前主角。
- `W/A/S/D` 或方向键：移动当前主角。
- `Shift`：加速移动。
- 松开移动键：从基建 `Move` 回到基建 `Relax` 待机。
- 右下角：播放攻击、技能 1、技能 2、技能 3；动作包含真实的起手、循环和收招片段（模型提供时）。
- `空格` 或“暂停”：冻结当前帧和移动。
- “聚焦角色 / 重置视角”：切换镜头距离。

## 实现结构

```text
浏览器
  └─ Vite / GitHub Pages
      ├─ Three.js 场景、灯光、相机和程序化庭院
      ├─ AlphaTest 深度景深后处理
      ├─ Billboard 帧图集角色播放器
      └─ PNG / Spine 3.8 资源由 Git LFS 管理
```

页面运行时的核心流程是：manifest 描述动画分页，`Character` 按帧切换透明 PNG 图集，Three.js 负责角色移动、相机跟随、景深焦点和动作状态；GitHub Actions 负责构建 `dist/` 并发布到 Pages。

## 角色资源

四名角色的源模型位于 `public/assets/char_*_source/`，每个角色包含 PRTS 已验证的默认、皮肤和 front/back/build Spine 资源；运行时动作包位于 `public/assets/characters/<id>/`：

- 新约能天使：`char_1041_angel2`
- 赤刃明霄陈：`char_1050_chen3`
- 黍：`char_2025_shu`
- 塑心：`char_245_cello`

每个运行时 manifest 同时记录 `front` 战斗动作和 `build` 基建动作，使用模型级 `bodyHeight` 与 `groundY` 统一脚底和人物高度。分页 PNG 的单页最多 8×8 帧，避免超过浏览器常用纹理尺寸。

## 转换流程

PRTS 的部分基建 PNG 实际像素尺寸小于 `.atlas` 声明尺寸。若直接交给 Spine 运行时，部件会被按错误坐标采样成碎片。因此转换前先运行：

```bash
node tools/normalize-atlas-images.mjs
node tools/convert-all.mjs
```

`normalize-atlas-images.mjs` 会把 atlas 引用的 PNG 补齐到 atlas 声明尺寸；`convert-all.mjs` 再通过 [tools/convert.html](tools/convert.html#L1) 在浏览器 WebGL 中读取 Spine 3.8.99 模型，输出四名角色的动作分页图集和 manifest。转换器会校验 PNG 与 atlas 尺寸，不一致时直接失败。

## 许可证

项目原创代码采用 [MIT License](LICENSE)。PRTS 角色模型、动作图集和其他角色素材由其页面及资源服务器提供，不属于本项目的 MIT 授权范围；公开部署或再分发前请确认这些素材的使用许可。