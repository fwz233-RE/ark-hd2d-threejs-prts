import * as THREE from 'three';

export function createStage(scene) {
  const stage = new THREE.Group();
  stage.name = 'Terracotta courtyard';
  scene.add(stage);
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.82, ...extra,
  });
  const cream = material('#d8bb90'), stone = material('#8c7375');
  const dark = material('#343f40'), wood = material('#693b3b');
  const red = material('#964e47'), brass = material('#bc9260', { metalness: 0.45 });
  const green = material('#687f48'), leafLight = material('#96a361');
  const soil = material('#473a32'), ceramic = material('#adb3a0');
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
  const cone = new THREE.ConeGeometry(1, 1, 5);
  const pot = new THREE.CylinderGeometry(0.46, 0.33, 0.64, 8);
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
  function canvasTexture(draw, size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    draw(ctx, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
  }
  const bricks = canvasTexture((ctx, s) => {
    ctx.fillStyle = '#8e7766'; ctx.fillRect(0, 0, s, s);
    const colors = ['#c98269', '#ce8c74', '#b97665', '#d39378', '#bb7c6b'];
    for (let row = 0; row < 8; row++) {
      for (let col = -1; col < 4; col++) {
        const x = col * 128 + (row % 2) * 64, y = row * 64;
        ctx.fillStyle = colors[((col + 5) * 7 + row * 3) % colors.length];
        ctx.fillRect(x + 3, y + 3, 122, 58);
        ctx.strokeStyle = '#e2b493'; ctx.lineWidth = 2;
        ctx.strokeRect(x + 4, y + 4, 120, 56);
        ctx.fillStyle = '#a56b5c'; ctx.fillRect(x + 6, y + 56, 116, 3);
      }
    }
  });
  bricks.repeat.set(5.5, 6);
  const paving = material('#ffffff', { map: bricks, bumpMap: bricks, bumpScale: 0.028 });
  box(paving, 0, -0.18, -1, 22, 0.36, 24);
  // A repeating four-tile quatrefoil: colors and the engraved normal share one drawing.
  function drawTiles(ctx, s, relief = false) {
    ctx.fillStyle = relief ? '#a0a0a0' : '#dab48a'; ctx.fillRect(0, 0, s, s);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const x = col * s / 2, y = row * s / 2, cell = s / 2;
        ctx.strokeStyle = relief ? '#555555' : '#786e50'; ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
        ctx.save(); ctx.translate(x + cell / 2, y + cell / 2);
        ctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const angle = i * Math.PI / 32;
          const radius = cell * (0.345 + 0.065 * Math.cos(angle * 4));
          const px = Math.cos(angle) * radius, py = Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = relief ? '#b0b0b0' : (row + col) % 2 ? '#ce7965' : '#778750';
        ctx.fill(); ctx.stroke();
        ctx.scale(0.9, 0.9);
        ctx.strokeStyle = relief ? '#808080' : '#b3a26d'; ctx.lineWidth = 2;
        ctx.stroke(); ctx.restore();
        ctx.fillStyle = relief ? '#777777' : '#9a8a5e';
        ctx.save(); ctx.translate(x + 13, y + 13); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-4, -4, 8, 8); ctx.restore();
      }
    }
  }
  const tiles = canvasTexture((ctx, s) => drawTiles(ctx, s));
  const relief = canvasTexture((ctx, s) => drawTiles(ctx, s, true));
  const source = relief.image.getContext('2d').getImageData(0, 0, 512, 512);
  const normals = new Uint8Array(512 * 512 * 4);
  const height = (x, y) => source.data[(((y + 512) % 512) * 512 + (x + 512) % 512) * 4] / 255;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const n = new THREE.Vector3((height(x - 1, y) - height(x + 1, y)) * 2,
      (height(x, y + 1) - height(x, y - 1)) * 2, 1).normalize();
    const i = (y * 512 + x) * 4;
    normals[i] = (n.x * 0.5 + 0.5) * 255; normals[i + 1] = (n.y * 0.5 + 0.5) * 255;
    normals[i + 2] = n.z * 255; normals[i + 3] = 255;
  }
  const normalMap = new THREE.DataTexture(normals, 512, 512);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.needsUpdate = true;
  tiles.repeat.set(3, 3); normalMap.repeat.copy(tiles.repeat);
  const inlay = material('#ffffff', { map: tiles, normalMap, normalScale: new THREE.Vector2(0.55, 0.55) });
  box(stone, 0, 0.045, 0, 11.2, 0.09, 10.2);
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(11, 10), inlay);
  carpet.rotation.x = -Math.PI / 2; carpet.position.y = 0.12;
  carpet.receiveShadow = true; stage.add(carpet);
  relief.dispose();
  for (const x of [-5.7, 5.7]) {
    box(wood, x, 0.075, 0, 0.38, 0.15, 10.6);
    box(cream, x, 0.17, 0, 0.36, 0.12, 10.7, true);
    box(brass, x, 0.234, 0, 0.035, 0.008, 10.35);
  }
  for (const z of [-5.3, 5.3]) {
    box(wood, 0, 0.075, z, 11.8, 0.15, 0.38);
    box(cream, 0, 0.17, z, 11.8, 0.12, 0.36, true);
    box(brass, 0, 0.234, z, 11.4, 0.008, 0.035);
  }
  for (const x of [-6.9, 6.9]) box(cream, x, 0.008, -1, 0.07, 0.016, 24);
  box(stone, 0, 0.25, -9.9, 22, 0.5, 2.2);
  box(cream, 0, 0.52, -8.85, 22, 0.09, 0.18, true);
  box(wood, 0, 2.1, -11.2, 22, 4.2, 0.4);
  box(dark, 0, 2.4, -10.96, 21.6, 2.7, 0.08);
  for (const x of [-10.4, -5.1, 0.2, 5.5, 10.4]) {
    box(red, x, 2.35, -10.65, 0.32, 4.7, 0.4, true);
    box(cream, x, 0.7, -10.65, 0.5, 0.27, 0.55, true);
    box(brass, x, 3.95, -10.65, 0.41, 0.1, 0.49);
  }
  for (const y of [1.1, 3.7, 4.4]) box(red, 0, y, -10.65, 22, 0.18, 0.35, true);
  // Each tread rises toward negative Z; the landing continues behind the wall opening.
  for (let i = 0; i < 9; i++) {
    const h = (i + 1) * 0.21, z = -6.4 - i * 0.59;
    box(red, -8.2, h / 2, z, 3.7, h, 0.6);
    box(cream, -8.2, h + 0.025, z + 0.2, 3.72, 0.05, 0.18, true);
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
  function terminal(x, z, vending) {
    const w = vending ? 1.65 : 1.2;
    box(dark, x, 0.68, z, w + 0.12, 0.24, 0.95, true);
    box(ceramic, x, 1.7, z, w, 2.1, 0.82, true);
    box(dark, x, 2.05, z + 0.425, w * 0.82, 1.2, 0.07, true);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.69, 1.02), screen);
    panel.position.set(x, 2.07, z + 0.467); stage.add(panel);
    box(brass, x, 2.85, z, w + 0.1, 0.12, 0.92, true);
    box(dark, x, 1.01, z + 0.43, w * 0.72, 0.27, 0.07);
    box(glow, x + w * 0.3, 1.35, z + 0.45, 0.12, 0.08, 0.04);
    if (vending) for (let i = 0; i < 5; i++) box(stone, x, 0.82 + i * 0.045, z + 0.46, 0.8, 0.014, 0.025);
  }
  terminal(-4.5, -8.9, true); terminal(4.6, -9.2, false);
  for (const x of [-2.3, 7.9]) {
    box(stone, x, 0.88, -9.2, 1.9, 0.65, 1, true);
    box(cream, x, 1.22, -9.2, 2.02, 0.13, 1.12, true);
    box(soil, x, 1.29, -9.2, 1.75, 0.02, 0.85);
    for (let i = 0; i < 17; i++) {
      const a = i * 2.4, r = 0.15 + (i % 4) * 0.12;
      instance(cone, i % 3 ? green : leafLight, x + Math.cos(a) * r, 1.62,
        -9.2 + Math.sin(a) * r * 0.6, 0.14, 0.65 + (i % 3) * 0.15, 0.12,
        Math.sin(a) * 0.35, a, Math.cos(a) * 0.35);
    }
  }
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
  for (let i = 0; i < 9; i++) instance(cone, green, 9.7, 0.95, -5.8,
    0.16, 0.9, 0.12, Math.sin(i * 2.4) * 0.4, i * 2.4, Math.cos(i * 2.4) * 0.4);
  for (const [geometry, byMaterial] of batches) for (const [mat, matrices] of byMaterial) {
    const mesh = new THREE.InstancedMesh(geometry, mat, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = mat !== paving; mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); stage.add(mesh);
  }
  return stage;
}
