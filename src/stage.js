import * as THREE from 'three';

export function createStage(scene) {
  const stage = new THREE.Group();
  stage.name = 'Terracotta courtyard';
  stage.userData.focusHeight = 0.12;
  scene.add(stage);
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.82, ...extra,
  });
  const cream = material('#d8bb90'), stone = material('#867776');
  const dark = material('#263c39'), wood = material('#563434');
  const red = material('#803d39'), brass = material('#b99a66', { metalness: 0.45 });
  const green = material('#3d5937', { side: THREE.DoubleSide });
  const leafLight = material('#71804b', { side: THREE.DoubleSide });
  const soil = material('#3c3029'), ceramic = material('#afb1a0');
  const glow = material('#ffe0a0', { emissive: '#ffc271', emissiveIntensity: 0.65 });
  const batches = new Map();
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const profile = new THREE.Shape();
  profile.moveTo(-0.46, -0.46);
  profile.lineTo(0.46, -0.46); profile.lineTo(0.46, 0.46);
  profile.lineTo(-0.46, 0.46); profile.closePath();
  const bevel = new THREE.ExtrudeGeometry(profile, {
    depth: 0.92, bevelEnabled: true, bevelSegments: 1,
    steps: 1, bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 1,
  });
  bevel.translate(0, 0, -0.46);
  const pot = new THREE.CylinderGeometry(0.46, 0.33, 0.64, 8);
  // Eight triangles form a tapered leaf with a raised midrib and a bent tip.
  // Every plant shares this geometry; double-sided materials keep the underside visible.
  const leaf = new THREE.BufferGeometry();
  leaf.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, -0.22, 0.35, 0.04, 0, 0.35, 0.13,
    0, 0, 0, 0, 0.35, 0.13, 0.22, 0.35, 0.04,
    -0.22, 0.35, 0.04, -0.16, 0.73, 0.14, 0, 0.73, 0.23,
    -0.22, 0.35, 0.04, 0, 0.73, 0.23, 0, 0.35, 0.13,
    0, 0.35, 0.13, 0, 0.73, 0.23, 0.16, 0.73, 0.14,
    0, 0.35, 0.13, 0.16, 0.73, 0.14, 0.22, 0.35, 0.04,
    -0.16, 0.73, 0.14, 0, 1, 0.36, 0, 0.73, 0.23,
    0, 0.73, 0.23, 0, 1, 0.36, 0.16, 0.73, 0.14,
  ], 3));
  leaf.computeVertexNormals();
  const dummy = new THREE.Object3D();
  function instance(geometry, mat, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    let byMaterial = batches.get(geometry);
    if (!byMaterial) batches.set(geometry, byMaterial = new Map());
    if (!byMaterial.has(mat)) byMaterial.set(mat, []);
    dummy.position.set(x, y, z); dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
    byMaterial.get(mat).push(dummy.matrix.clone());
  }
  const box = (mat, x, y, z, w, h, d, rounded = false) =>
    instance(rounded ? bevel : cube, mat, x, y, z, w, h, d);
  function canvasTexture(draw, size = 512, color = true) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    draw(canvas.getContext('2d'), size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
  }
  const noise = (x, y, seed = 0) => {
    let n = Math.imul(x + seed * 101, 374761393) ^ Math.imul(y + 31, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  function patina(ctx, s, relief, seed) {
    // Integer hashing keeps chips and clay pores identical on every stage creation.
    for (let i = 0; i < s * 12; i++) {
      const x = Math.floor(noise(i, 1, seed) * s), y = Math.floor(noise(i, 2, seed) * s);
      const light = noise(i, 3, seed) > 0.55;
      ctx.fillStyle = relief ? (light ? '#b7b7b7' : '#7d7d7d')
        : (light ? 'rgba(244,216,172,0.13)' : 'rgba(48,35,27,0.12)');
      ctx.fillRect(x, y, 1 + noise(i, 4, seed) * 2, 1 + noise(i, 5, seed) * 2);
    }
  }
  function drawBricks(ctx, s, relief) {
    ctx.fillStyle = relief ? '#373737' : '#958875'; ctx.fillRect(0, 0, s, s);
    const colors = ['#bd7560', '#b86c58', '#cb8269', '#ad6656', '#c17c65'];
    const bw = s / 4, bh = s / 8;
    for (let row = 0; row < 8; row++) for (let col = -1; col < 4; col++) {
      const x = col * bw + (row % 2) * bw / 2, y = row * bh;
      const tone = 151 + Math.floor(noise(col + 1, row) * 18);
      ctx.fillStyle = relief ? `rgb(${tone},${tone},${tone})` : colors[(col + 5 + row * 3) % colors.length];
      ctx.fillRect(x + 3, y + 3, bw - 6, bh - 6);
      ctx.strokeStyle = relief ? '#cccccc' : '#deb294'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 4, y + 4, bw - 8, bh - 8);
      ctx.fillStyle = relief ? '#686868' : '#925a4e';
      ctx.fillRect(x + 5, y + bh - 6, bw - 10, 2);
      ctx.strokeStyle = relief ? '#888888' : 'rgba(99,64,48,0.24)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 12, y + 13); ctx.lineTo(x + bw * 0.63, y + 15); ctx.stroke();
    }
    patina(ctx, s, relief, 7);
  }
  const bricks = canvasTexture((ctx, s) => drawBricks(ctx, s, false));
  const brickHeight = canvasTexture((ctx, s) => drawBricks(ctx, s, true), 512, false);
  bricks.repeat.set(7, 9); brickHeight.repeat.copy(bricks.repeat);
  const paving = material('#ffffff', { map: bricks, bumpMap: brickHeight, bumpScale: 0.035 });
  box(paving, 0, -0.18, 2, 28, 0.36, 36);

  function quatrefoil(ctx, radius) {
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = i * Math.PI / 48, r = radius * (0.86 + 0.14 * Math.cos(a * 4));
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function diamond(ctx, x, y, r) {
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  }
  function drawTiles(ctx, s, relief) {
    ctx.fillStyle = relief ? '#424242' : '#776d59'; ctx.fillRect(0, 0, s, s);
    const cell = s / 4;
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
      ctx.save(); ctx.translate((col + 0.5) * cell, (row + 0.5) * cell);
      ctx.fillStyle = relief ? '#a9a9a9' : '#cbb087';
      ctx.fillRect(-cell / 2 + 2, -cell / 2 + 2, cell - 4, cell - 4);
      ctx.strokeStyle = relief ? '#757575' : '#918260'; ctx.lineWidth = 1.5;
      ctx.strokeRect(-cell / 2 + 5, -cell / 2 + 5, cell - 10, cell - 10);
      const isRed = (row + col) % 2;
      const fill = isRed ? ['#a95145', '#b15b4a', '#aa5346', '#b35c4d'][row]
        : ['#405c42', '#4a6446', '#465d40', '#506749'][col];
      // Nested bands describe the same relief independently of the glaze's hue.
      for (const [radius, color, gray] of [
        [0.479, '#54604a', '#777777'], [0.463, '#d6bc90', '#b8b8b8'],
        [0.443, '#927757', '#858585'], [0.428, '#d6bc90', '#b4b4b4'],
        [0.406, fill, '#a4a4a4'],
      ]) {
        quatrefoil(ctx, cell * radius); ctx.fillStyle = relief ? gray : color; ctx.fill();
      }
      quatrefoil(ctx, cell * 0.383);
      ctx.strokeStyle = relief ? '#969696' : (isRed ? '#ca8060' : '#829062');
      ctx.lineWidth = 1.3; ctx.stroke();
      for (const [x, y] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
        diamond(ctx, x * cell, y * cell, cell * 0.047);
        ctx.strokeStyle = relief ? '#727272' : '#657052'; ctx.lineWidth = 1.5; ctx.stroke();
        diamond(ctx, x * cell, y * cell, cell * 0.022);
        ctx.fillStyle = relief ? '#b8b8b8' : '#ae8a5e'; ctx.fill();
      }
      // Small glaze abrasions stay inside the colored motif.
      ctx.save(); quatrefoil(ctx, cell * 0.40); ctx.clip();
      for (let i = 0; i < 24; i++) {
        const x = (noise(i, row, col + 19) - 0.5) * cell;
        const y = (noise(i, col, row + 29) - 0.5) * cell;
        ctx.fillStyle = relief ? '#929292' : 'rgba(209,179,133,0.22)';
        ctx.fillRect(x, y, 2 + noise(i, row, 41) * 13, 1.2);
      }
      ctx.restore(); ctx.restore();
    }
    patina(ctx, s, relief, 23);
  }
  const tiles = canvasTexture((ctx, s) => drawTiles(ctx, s, false), 1024);
  const tileHeight = canvasTexture((ctx, s) => drawTiles(ctx, s, true), 1024, false);
  tiles.repeat.set(2, 2.5); tileHeight.repeat.copy(tiles.repeat);
  const inlay = material('#ffffff', { map: tiles, bumpMap: tileHeight, bumpScale: 0.022, roughness: 0.72 });
  box(stone, 0, 0.045, 0, 14.6, 0.09, 17.2);
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(14.4, 17), inlay);
  carpet.rotation.x = -Math.PI / 2; carpet.position.y = 0.12;
  carpet.receiveShadow = true; stage.add(carpet);
  // Segmented, bevelled limestone coping reveals dark joints and a recessed inner reveal.
  for (const x of [-7.4, 7.4]) {
    box(wood, x, 0.075, 0, 0.38, 0.15, 17.6);
    box(dark, x - Math.sign(x) * 0.205, 0.103, 0, 0.045, 0.025, 17.2);
    for (let i = 0; i < 12; i++) box(cream, x, 0.17, -8.12 + i * 1.476, 0.36, 0.12, 1.46, true);
    box(brass, x, 0.234, 0, 0.025, 0.008, 17.35);
  }
  for (const z of [-8.8, 8.8]) {
    box(wood, 0, 0.075, z, 15.2, 0.15, 0.38);
    for (let i = 0; i < 10; i++) box(cream, -6.84 + i * 1.52, 0.17, z, 1.50, 0.12, 0.36, true);
    box(brass, 0, 0.234, z, 14.8, 0.008, 0.025);
  }
  for (const x of [-8.6, 8.6]) box(cream, x, 0.008, 2, 0.07, 0.016, 36);
  // Foreground kerb and low planters remain beyond x ±6.3 / z ±7.3 walk bounds.
  box(stone, 0, 0.06, 10.15, 21.6, 0.12, 0.42, true);
  box(cream, 0, 0.125, 10.15, 21.7, 0.05, 0.28, true);
  for (const x of [-10.8, 10.8]) {
    box(stone, x, 0.08, 1.2, 0.32, 0.16, 18.3, true);
    box(cream, x, 0.17, 1.2, 0.22, 0.04, 18.3, true);
  }
  box(stone, 0, 0.25, -9.9, 22, 0.5, 2.2);
  box(cream, 0, 0.52, -8.85, 22, 0.09, 0.18, true);
  // Taller backing and short return walls frame the courtyard at oblique camera anchors.
  box(wood, 0, 3.1, -11.2, 24, 6.2, 0.4);
  box(dark, 0, 5.32, -10.96, 23.6, 1.48, 0.08);
  for (const y of [4.72, 5.96]) box(red, 0, y, -10.78, 24, 0.14, 0.24, true);
  for (const x of [-11.7, 11.7]) {
    box(wood, x, 1.18, -1.7, 0.38, 2.36, 18.6);
    box(dark, x - Math.sign(x) * 0.21, 1.28, -1.7, 0.06, 1.72, 18.2);
    box(cream, x, 0.3, -1.7, 0.54, 0.28, 18.7, true);
    box(red, x, 2.38, -1.7, 0.6, 0.16, 18.8, true);
    for (let i = 0; i < 7; i++) {
      box(red, x - Math.sign(x) * 0.26, 1.3, -10.3 + i * 2.85, 0.13, 2.05, 0.14, true);
    }
  }
  box(dark, 0, 2.4, -10.96, 21.6, 2.7, 0.08);
  // Deep inset bays, raised timber rails, and narrow shadow reveals.
  for (const [left, right] of [[-10.4, -5.1], [-5.1, 0.2], [0.2, 5.5], [5.5, 10.4]]) {
    const center = (left + right) / 2, width = right - left - 0.5;
    box(wood, center, 1.02, -10.84, width, 0.86, 0.12, true);
    box(dark, center, 2.55, -10.88, width, 2.05, 0.08);
    for (const y of [1.49, 3.61]) box(wood, center, y, -10.72, width + 0.08, 0.11, 0.20, true);
    for (const x of [left + 0.30, right - 0.30]) box(red, x, 2.55, -10.73, 0.10, 2.2, 0.18, true);
    for (let i = 0; i < 7; i++) {
      const x = left + 0.48 + (width - 0.46) * i / 6;
      box(red, x, 1.01, -10.75, 0.055, 0.66, 0.06);
    }
    for (const x of [center - width * 0.26, center + width * 0.26]) {
      box(wood, x, 2.61, -10.78, 0.065, 1.92, 0.12);
    }
    box(brass, center, 1.43, -10.60, width, 0.025, 0.025);
  }
  for (const x of [-10.4, -5.1, 0.2, 5.5, 10.4]) {
    box(wood, x, 2.35, -10.71, 0.44, 4.7, 0.48, true);
    box(red, x, 2.35, -10.44, 0.25, 4.35, 0.12, true);
    box(stone, x, 0.61, -10.65, 0.61, 0.38, 0.64, true);
    box(cream, x, 0.82, -10.65, 0.52, 0.12, 0.57, true);
    box(brass, x, 3.95, -10.65, 0.48, 0.10, 0.54);
    box(red, x, 4.18, -10.61, 0.59, 0.20, 0.59, true);
    box(wood, x, 4.34, -10.60, 0.75, 0.14, 0.65, true);
  }
  for (const y of [1.1, 3.7, 4.4]) box(red, 0, y, -10.65, 22, 0.18, 0.35, true);
  box(cream, 0, 0.60, -10.60, 21.7, 0.08, 0.19, true);
  box(wood, 0, 4.60, -10.73, 22.3, 0.18, 0.76, true);
  // Each tread rises toward negative Z; the landing continues behind the wall opening.
  for (let i = 0; i < 9; i++) {
    const h = (i + 1) * 0.21, z = -6.4 - i * 0.59;
    box(red, -8.2, h / 2, z, 3.7, h, 0.6);
    box(cream, -8.2, h + 0.025, z + 0.2, 3.72, 0.05, 0.18, true);
    box(wood, -8.2, h - 0.05, z + 0.302, 3.6, 0.025, 0.015);
    for (const x of [-10.2, -6.2]) box(stone, x, h / 2 + 0.24, z, 0.24, h + 0.48, 0.6);
  }
  const screenTexture = canvasTexture((ctx, s) => {
    ctx.fillStyle = '#254c4c'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#bce9cf'; ctx.fillRect(30, 30, 452, 65);
    ctx.fillStyle = '#356862'; ctx.font = 'bold 34px sans-serif'; ctx.fillText('COURTYARD / 07', 48, 75);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = ['#86cbb2', '#e3b267', '#dc8d87'][i % 3];
      ctx.fillRect(45 + (i % 2) * 228, 130 + Math.floor(i / 2) * 112, 190, 85);
      ctx.fillStyle = '#e7e9cc'; ctx.fillRect(65 + (i % 2) * 228, 190 + Math.floor(i / 2) * 112, 110, 6);
    }
  });
  const screen = material('#ffffff', { map: screenTexture, emissiveMap: screenTexture,
    emissive: '#9ee2cf', emissiveIntensity: 0.45, roughness: 0.35 });
  const panelGeometry = new THREE.PlaneGeometry(1, 1);
  function terminal(x, z, vending) {
    const w = vending ? 1.65 : 1.2;
    box(dark, x, 0.68, z, w + 0.12, 0.24, 0.95, true);
    box(ceramic, x, 1.7, z, w, 2.1, 0.82, true);
    box(wood, x, 1.72, z - 0.43, w * 0.89, 1.85, 0.10, true);
    box(dark, x, 2.05, z + 0.425, w * 0.88, 1.28, 0.045, true);
    // Bezel rails project beyond a recessed screen, with a separate projecting hood.
    for (const side of [-1, 1]) {
      box(ceramic, x + side * w * 0.43, 2.05, z + 0.49, w * 0.07, 1.31, 0.17, true);
    }
    for (const y of [1.42, 2.68]) box(ceramic, x, y, z + 0.49, w * 0.88, 0.085, 0.17, true);
    instance(panelGeometry, screen, x, 2.07, z + 0.457, w * 0.69, 1.02, 1);
    box(brass, x, 2.85, z + 0.04, w + 0.1, 0.12, 1.04, true);
    box(dark, x, 1.01, z + 0.43, w * 0.72, 0.27, 0.035);
    box(ceramic, x, 0.85, z + 0.51, w * 0.80, 0.07, 0.20, true);
    box(ceramic, x, 1.19, z + 0.50, w * 0.80, 0.06, 0.16, true);
    box(glow, x + w * 0.3, 1.35, z + 0.53, 0.12, 0.08, 0.04);
    box(brass, x - w * 0.23, 1.33, z + 0.47, w * 0.24, 0.025, 0.025);
    for (let i = 0; i < 6; i++) box(dark, x + w / 2 + 0.006, 1.26 + i * 0.09, z - 0.08, 0.016, 0.025, 0.36);
    if (vending) for (let i = 0; i < 5; i++) box(stone, x, 0.91 + i * 0.045, z + 0.46, 0.8, 0.014, 0.025);
  }
  terminal(-4.5, -8.9, true); terminal(4.6, -9.2, false);
  function foliage(x, y, z, count, scale = 1) {
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996, r = (0.09 + (i % 4) * 0.12) * scale;
      instance(leaf, i % 3 ? green : leafLight,
        x + Math.cos(a) * r, y, z + Math.sin(a) * r * 0.65,
        (0.55 + (i % 3) * 0.13) * scale, (0.55 + (i % 5) * 0.13) * scale, 0.7 * scale,
        Math.sin(a) * 0.38, a, Math.cos(a) * 0.38);
    }
  }
  function planter(x, z, low = false) {
    const base = low ? 0.10 : 0.555, h = low ? 0.44 : 0.65;
    box(stone, x, base + h / 2, z, 1.9, h, 1, true);
    box(wood, x, base + 0.08, z + 0.505, 1.75, 0.08, 0.025);
    // Four coping strips leave the soil visibly below the stone lip.
    for (const side of [-1, 1]) {
      box(cream, x + side * 0.94, base + h, z, 0.15, 0.13, 1.12, true);
      box(cream, x, base + h, z + side * 0.49, 1.75, 0.13, 0.14, true);
    }
    box(soil, x, base + h - 0.04, z, 1.72, 0.025, 0.84);
    foliage(x, base + h - 0.02, z, low ? 12 : 17, low ? 0.72 : 1);
  }
  for (const x of [-2.3, 7.9]) planter(x, -9.2);
  for (const x of [-9.1, 9.1]) planter(x, 6.9, true);
  for (let i = 0; i < 5; i++) box(wood, 1.2, 0.99, -8.6 + i * 0.14, 2.9, 0.11, 0.1, true);
  for (let i = 0; i < 3; i++) box(wood, 1.2, 1.32 + i * 0.18, -8.72, 2.9, 0.13, 0.1, true);
  for (const x of [0.05, 2.35]) box(dark, x, 0.77, -8.35, 0.12, 0.48, 0.7);
  for (const x of [-3, 3, 9]) {
    box(brass, x, 3.16, -10.37, 0.13, 0.7, 0.45);
    box(dark, x, 3.13, -10.05, 0.53, 0.74, 0.45, true);
    box(glow, x, 3.13, -9.81, 0.36, 0.5, 0.035);
    box(brass, x, 3.55, -10.05, 0.64, 0.13, 0.56, true);
  }
  instance(pot, ceramic, 9.7, 0.32, -5.8, 1, 1, 1);
  box(soil, 9.7, 0.63, -5.8, 0.55, 0.02, 0.55);
  foliage(9.7, 0.63, -5.8, 9);
  for (const [geometry, byMaterial] of batches) for (const [mat, matrices] of byMaterial) {
    const mesh = new THREE.InstancedMesh(geometry, mat, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = mat !== paving && mat !== screen; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); stage.add(mesh);
  }
  return stage;
}
