import { HalfFloatType, ShaderMaterial, Vector2, WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Flatten an interrupted blend before releasing its atlas pages. Two alternating
// targets let a new capture read the preceding snapshot without feedback.
export class PoseSnapshot {
  constructor() {
    this.targets = [0, 1].map(() => new WebGLRenderTarget(512, 512, {
      type: HalfFloatType, depthBuffer: false,
    }));
    this.material = new ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        currentMap: { value: null }, previousMap: { value: null }, blend: { value: 1 },
        previousPremultiplied: { value: 0 },
        currentRect: { value: null }, previousRect: { value: null },
        currentSize: { value: null }, previousSize: { value: null },
        currentCenter: { value: null }, previousCenter: { value: null },
        drawSize: { value: new Vector2() }, drawCenter: { value: new Vector2() },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        uniform sampler2D currentMap; uniform sampler2D previousMap;
        uniform vec4 currentRect; uniform vec4 previousRect;
        uniform vec2 currentSize; uniform vec2 previousSize;
        uniform vec2 currentCenter; uniform vec2 previousCenter;
        uniform vec2 drawSize; uniform vec2 drawCenter;
        uniform float blend;
        vec4 pose(sampler2D image, vec4 rect, vec2 size, vec2 center, vec2 point) {
          vec2 local = (point - center) / size + 0.5;
          if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return vec4(0.0);
          return texture2D(image, rect.xy + local * rect.zw);
        }
        void main() {
          vec2 point = (vUv - 0.5) * drawSize + drawCenter;
          vec4 a = pose(previousMap, previousRect, previousSize, previousCenter, point);
          vec4 b = pose(currentMap, currentRect, currentSize, currentCenter, point);
          float coverage = mix(a.a, b.a, blend);
          vec3 premultiplied = mix(a.rgb * a.a, b.rgb * b.a, blend);
          gl_FragColor = vec4(premultiplied / max(coverage, 0.00001), coverage);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
    this.index = 0;
  }

  capture(renderer, character) {
    const pose = character._poseUniforms;
    const uniforms = this.material.uniforms;
    uniforms.currentMap.value = character.material.map;
    uniforms.previousMap.value = pose.posePreviousMap.value;
    uniforms.blend.value = pose.poseBlend.value;
    for (const name of ['Rect', 'Size', 'Center']) {
      uniforms[`current${name}`].value = pose[`pose${name}`].value;
      uniforms[`previous${name}`].value = pose[`posePrevious${name}`].value;
    }
    uniforms.drawSize.value.copy(pose.poseDrawSize.value);
    uniforms.drawCenter.value.copy(pose.poseDrawCenter.value);
    const target = this.targets[this.index];
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
      this.index = 1 - this.index;
    } finally {
      renderer.setRenderTarget(oldTarget);
      renderer.autoClear = oldAutoClear;
    }
    return { texture: target.texture, size: uniforms.drawSize.value.clone(), center: uniforms.drawCenter.value.clone() };
  }
}
