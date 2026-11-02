import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { AlphaBokehPass } from './AlphaBokehPass.js';
import { Character } from './Character.js';
import { createStage } from './stage.js';

const characterIds = ['char_1041_angel2', 'char_1050_chen3', 'char_2025_shu', 'char_245_cello'];
const assetBase = import.meta.env.BASE_URL;
const actionLabels = { idle: '待机', move: '行走', attack: '攻击', skill1: '技能 1', skill2: '技能 2', skill3: '技能 3' };
const status = document.getElementById('asset-status');
const labelsRoot = document.getElementById('labels');
const rosterRoot = document.getElementById('character-roster');
const motionStatus = document.getElementById('motion-status');
const pauseButton = document.getElementById('pause-button');
const actionButtons = [...document.querySelectorAll('[data-action]')];
const scene = new THREE.Scene();
scene.background = new THREE.Color('#393c43');
scene.fog = new THREE.Fog('#393c43', 32, 65);

const camera = new THREE.PerspectiveCamera(39, innerWidth / innerHeight, 0.1, 80);
const initialPosition = new THREE.Vector3(0, 0.16, 2.8);
const cameraOffset = new THREE.Vector3(0, 6.8, 10.8);
const targetOffset = new THREE.Vector3(0, 0.8, -2.4);
const destination = initialPosition.clone().add(cameraOffset);
const lookTarget = initialPosition.clone().add(targetOffset);
camera.position.copy(destination);
camera.lookAt(lookTarget);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.15));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Only the static courtyard casts shadow-map shadows; sprites use contact shadows.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('scene-root').appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight('#dce8ff', '#79655d', 1.7));
const sunlight = new THREE.DirectionalLight('#ffe0b9', 2.8);
sunlight.position.set(-6, 13, 7);
sunlight.castShadow = true;
sunlight.shadow.mapSize.set(1024, 1024);
Object.assign(sunlight.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, far: 45 });
sunlight.shadow.normalBias = 0.03;
sunlight.shadow.bias = -0.0001;
scene.add(sunlight);
const stage = createStage(scene);
const composer = new EffectComposer(renderer);
const dof = new AlphaBokehPass(scene, camera, {
  focus: 10.5,
  renderScale: 0.5,
});
dof.setViewport(innerWidth, innerHeight);
composer.addPass(dof);
composer.addPass(new OutputPass());

const shadowCanvas = document.createElement('canvas');
shadowCanvas.width = shadowCanvas.height = 128;
const shadowContext = shadowCanvas.getContext('2d');
const shadowGradient = shadowContext.createRadialGradient(64, 64, 3, 64, 64, 63);
shadowGradient.addColorStop(0, 'rgba(33,25,31,.65)');
shadowGradient.addColorStop(0.55, 'rgba(33,25,31,.3)');
shadowGradient.addColorStop(1, 'rgba(33,25,31,0)');
shadowContext.fillStyle = shadowGradient;
shadowContext.fillRect(0, 0, 128, 128);
const shadowTexture = new THREE.CanvasTexture(shadowCanvas);

const characters = [];
const rosterButtons = [];
const keys = new Set();
const velocity = new THREE.Vector3();
const desiredVelocity = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const cameraAnchor = initialPosition.clone();
const focusProbe = new THREE.Vector3(0, stage.userData.focusHeight ?? 0.12, 0.6);
const focusSpace = new THREE.Vector3();
const labelRay = new THREE.Raycaster();
const labelTarget = new THREE.Vector3();
const labelDirection = new THREE.Vector3();
let labelOcclusionTime = 0;
const clock = new THREE.Clock();
let player;
let selectedIndex = 0;
let paused = false;
let ready = false;
let lastState = '';

function reportError(error) {
  status.className = 'asset-status error';
  status.textContent = `资源加载失败：${error?.message || '请重试动作'}`;
  console.error(error);
}

function selectCharacter(index) {
  if (!ready || !characters[index]) return;
  keys.clear();
  velocity.set(0, 0, 0);
  if (player) {
    player.setActive(false);
    player.resetIdle();
  }
  selectedIndex = index;
  player = characters[index];
  player.setActive(true);
  player.resetIdle();
  rosterButtons.forEach((button, i) => {
    button.classList.toggle('active', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
  lastState = '';
  status.className = 'asset-status ready';
  status.textContent = `${player.role.name} · 当前主角`;
}

async function initialize() {
  status.textContent = '正在加载四名干员的待机与行走动作…';
  const manifests = await Promise.all(characterIds.map(async id => {
    const response = await fetch(`${assetBase}assets/characters/${id}/manifest.json`);
    if (!response.ok) throw new Error(`${id} HTTP ${response.status}`);
    return response.json();
  }));
  const positions = [[0, 0.16, 2.8], [-2.8, 0.16, 0.6], [2.7, 0.16, -0.2], [-1.4, 0.16, -3.5]];
  manifests.forEach((manifest, index) => {
    const role = { id: manifest.id, name: manifest.name, manifest };
    const character = new Character({ role, position: positions[index], scene, labelsRoot, shadowTexture, renderer, onError: reportError });
    characters.push(character);
    dof.addCharacter(character);
    const button = document.createElement('button');
    button.className = 'character-button';
    button.dataset.character = String(index);
    button.disabled = true;
    const number = document.createElement('span');
    number.className = 'roster-number';
    number.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = role.name;
    button.append(number, name);
    button.addEventListener('click', () => selectCharacter(index));
    rosterRoot.appendChild(button);
    rosterButtons.push(button);
  });
  await Promise.all(characters.map(character => character.init()));
  ready = true;
  rosterButtons.forEach(button => { button.disabled = false; });
  selectCharacter(0);
}
initialize().catch(reportError);

function togglePause() {
  paused = !paused;
  keys.clear();
  velocity.set(0, 0, 0);
  pauseButton.textContent = paused ? '继续' : '暂停';
  pauseButton.classList.toggle('active', paused);
  pauseButton.setAttribute('aria-pressed', String(paused));
  lastState = '';
}

function playAction(action) {
  if (!ready) return;
  keys.clear();
  velocity.set(0, 0, 0);
  if (action === 'idle') player.resetIdle();
  else void player.playAction(action);
}

pauseButton.addEventListener('click', togglePause);
actionButtons.forEach(button => button.addEventListener('click', () => playAction(button.dataset.action)));
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat) togglePause();
  } else if (/^Digit[1-4]$/.test(event.code)) {
    if (!event.repeat) selectCharacter(Number(event.code.at(-1)) - 1);
    event.preventDefault();
  } else if (movementKeys.has(event.code)) {
    keys.add(event.code);
    event.preventDefault();
  }
});
addEventListener('keyup', event => keys.delete(event.code));
function releaseKeys() {
  keys.clear();
  velocity.set(0, 0, 0);
}
addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  dof.setViewport(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  if (ready && !paused) {
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3.5 : 2.1;
    const x = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const z = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
    desiredVelocity.set(x, 0, z).normalize().multiplyScalar(speed);
    velocity.lerp(desiredVelocity, 1 - Math.exp(-18 * delta));
    if (velocity.lengthSq() < 0.001) velocity.set(0, 0, 0);
    const wantsToMove = desiredVelocity.lengthSq() > 0;
    const moving = wantsToMove || velocity.lengthSq() > 0;
    // Intent drives the animation even while its first page is loading. Position
    // advances only once Move is visible, avoiding a frozen pose sliding around.
    player.setMoving(moving, x, Math.max(0.15, velocity.length() / 2.1));
    if (player.canMove) {
      player.group.position.addScaledVector(velocity, delta);
      player.group.position.x = THREE.MathUtils.clamp(player.group.position.x, -6.3, 6.3);
      player.group.position.z = THREE.MathUtils.clamp(player.group.position.z, -7.3, 7.3);
    }
  }
  const anchor = player ? player.group.position : initialPosition;
  // Partial follow leaves room for walking through the camera's focal plane.
  cameraAnchor.copy(initialPosition).lerp(anchor, 0.75);
  const framingScale = THREE.MathUtils.clamp(0.95 / camera.aspect, 1, 1.9);
  destination.copy(cameraAnchor).addScaledVector(cameraOffset, framingScale);
  targetPosition.copy(cameraAnchor).add(targetOffset);
  const cameraBlend = paused ? 0 : 1 - Math.exp(-5 * delta);
  camera.position.lerp(destination, cameraBlend);
  lookTarget.lerp(targetPosition, cameraBlend);
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld();
  focusSpace.copy(cameraAnchor).add(focusProbe).applyMatrix4(camera.matrixWorldInverse);
  dof.setFocus(-focusSpace.z);
  characters.forEach(character => character.update(delta, camera, paused));
  labelOcclusionTime += delta;
  if (labelOcclusionTime >= 0.12) {
    labelOcclusionTime = 0;
    for (const character of characters) {
      labelTarget.copy(character.group.position);
      labelTarget.y += (character.role.manifest.targetHeight ?? 1.65) * 0.65;
      labelDirection.subVectors(labelTarget, camera.position);
      const distance = labelDirection.length();
      labelRay.set(camera.position, labelDirection.normalize());
      labelRay.far = Math.max(0, distance - 0.1);
      const occluded = labelRay.intersectObject(stage, true).length > 0;
      character.label.style.visibility = occluded ? 'hidden' : '';
    }
  }
  if (player) {
    const state = paused ? 'paused' : player.playbackState;
    const displayState = player.preparing && !paused ? `preparing:${state}` : state;
    if (displayState !== lastState) {
      lastState = displayState;
      motionStatus.textContent = paused ? '已暂停'
        : player.preparing ? `准备${actionLabels[state]}…` : actionLabels[state];
      actionButtons.forEach(button => button.classList.toggle('active', button.dataset.action === state));
      status.title = player.actionNote || '';
    }
  }
  composer.render();
});
