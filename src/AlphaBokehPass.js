import {
  Box2, Color, CustomBlending, DepthTexture, HalfFloatType, NearestFilter,
  OneFactor, OneMinusSrcAlphaFactor, UnsignedIntType, Vector2, Vector3, Vector4, WebGLRenderTarget,
} from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const lensShader = /* glsl */`
  #include <packing>
  varying vec2 vUv;
  uniform float focus;
  uniform float nearClip;
  uniform float farClip;
  uniform float nearClear;
  uniform float farClear;
  uniform float nearRange;
  uniform float farRange;
  uniform float nearBlur;
  uniform float farBlur;
  uniform float strength;
  uniform vec2 viewport;
  float viewDepth(float depth) {
    return -perspectiveDepthToViewZ(depth, nearClip, farClip);
  }
  float radiusAt(float depth) {
    float n = smoothstep(nearClear, nearClear + nearRange, focus - depth);
    float f = smoothstep(farClear, farClear + farRange, depth - focus);
    return strength * (nearBlur * n + farBlur * f);
  }
  float compatibleDepth(float a, float b) {
    return 1.0 - smoothstep(0.4, 1.6, abs(a - b));
  }
`;

const lensUniforms = () => ({
  focus: { value: 12 }, nearClip: { value: 0.1 }, farClip: { value: 80 },
  nearClear: { value: 1.8 }, farClear: { value: 2.4 },
  nearRange: { value: 4 }, farRange: { value: 9 },
  nearBlur: { value: 2.5 }, farBlur: { value: 6 }, strength: { value: 1 },
  viewport: { value: new Vector2(1, 1) },
});

const worldBlurShader = {
  name: 'CourtyardWorldBlur', vertexShader,
  uniforms: { ...lensUniforms(), tColor: { value: null }, tDepth: { value: null } },
  fragmentShader: /* glsl */`
    ${lensShader}
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    void main() {
      float depth = viewDepth(texture2D(tDepth, vUv).r);
      float radius = radiusAt(depth);
      vec3 sum = texture2D(tColor, vUv).rgb;
      float total = 1.0;
      if (radius > 0.35) {
        for (int i = 0; i < 12; i++) {
          float angle = float(i) * 2.39996323;
          vec2 disk = vec2(cos(angle), sin(angle)) * sqrt((float(i) + 0.5) / 12.0);
          vec2 uv = vUv + disk * radius / viewport;
          float sampleDepth = viewDepth(texture2D(tDepth, uv).r);
          float weight = compatibleDepth(depth, sampleDepth);
          sum += texture2D(tColor, uv).rgb * weight;
          total += weight;
        }
      }
      gl_FragColor = vec4(sum / total, depth);
    }
  `,
};

const worldCompositeShader = {
  name: 'CourtyardWorldComposite', vertexShader,
  uniforms: {
    ...lensUniforms(), tColor: { value: null }, tDepth: { value: null },
    tBlur: { value: null }, blurSize: { value: new Vector2(1, 1) },
  },
  fragmentShader: /* glsl */`
    ${lensShader}
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform sampler2D tBlur;
    uniform vec2 blurSize;
    void main() {
      vec3 original = texture2D(tColor, vUv).rgb;
      float depth = viewDepth(texture2D(tDepth, vUv).r);
      float radius = radiusAt(depth);
      if (radius <= 0.35) { gl_FragColor = vec4(original, 1.0); return; }
      vec2 pixel = vUv * blurSize - 0.5;
      vec2 base = floor(pixel);
      vec2 fraction = fract(pixel);
      vec3 sum = vec3(0.0);
      float total = 0.0;
      for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 2; x++) {
          vec2 corner = vec2(float(x), float(y));
          vec4 sampleColor = texture2D(tBlur, (base + corner + 0.5) / blurSize);
          vec2 blend = mix(1.0 - fraction, fraction, corner);
          float weight = blend.x * blend.y * compatibleDepth(depth, sampleColor.a);
          sum += sampleColor.rgb * weight;
          total += weight;
        }
      }
      vec3 blurred = (sum + original * 0.0001) / (total + 0.0001);
      gl_FragColor = vec4(mix(original, blurred, smoothstep(0.35, 1.5, radius)), 1.0);
    }
  `,
};

const spriteCompositeShader = {
  name: 'PremultipliedCharacterBokeh', vertexShader,
  uniforms: {
    ...lensUniforms(), tSprite: { value: null }, tWorldDepth: { value: null },
    spriteDepth: { value: 1 }, spriteBounds: { value: new Vector4(0, 0, 1, 1) },
    drawingSize: { value: new Vector2(1, 1) },
  },
  fragmentShader: /* glsl */`
    ${lensShader}
    uniform sampler2D tSprite;
    uniform sampler2D tWorldDepth;
    uniform float spriteDepth;
    uniform vec4 spriteBounds;
    uniform vec2 drawingSize;
    vec4 spriteSample(vec2 uv) {
      vec2 inset = 0.5 / drawingSize;
      if (any(lessThan(uv, spriteBounds.xy + inset)) || any(greaterThan(uv, spriteBounds.zw - inset))) return vec4(0.0);
      return texture2D(tSprite, uv);
    }
    void main() {
      float worldDepth = viewDepth(texture2D(tWorldDepth, vUv).r);
      if (spriteDepth > worldDepth + 0.03) discard;
      float radius = radiusAt(spriteDepth);
      vec4 original = spriteSample(vUv);
      vec4 sum = original;
      for (int i = 0; i < 12; i++) {
        float angle = float(i) * 2.39996323;
        vec2 disk = vec2(cos(angle), sin(angle)) * sqrt((float(i) + 0.5) / 12.0);
        sum += spriteSample(vUv + disk * radius / viewport);
      }
      // Apply one kernel to premultiplied RGB and coverage. No division by alpha.
      gl_FragColor = mix(original, sum / 13.0, smoothstep(0.35, 1.5, radius));
    }
  `,
};

export class AlphaBokehPass extends Pass {
  constructor(scene, camera, params = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.characters = [];
    this.renderScale = params.renderScale ?? 0.5;
    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'Clean courtyard color';
    this.sceneTarget.depthTexture.name = 'Courtyard occlusion depth';
    this.blurTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
    });
    // Reused for each defocused billboard; clear/render only its screen rectangle.
    this.spriteTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.spriteTarget.texture.name = 'Character premultiplied RGB and coverage';
    this.worldBlur = new ShaderPass(worldBlurShader);
    this.worldComposite = new ShaderPass(worldCompositeShader);
    this.worldComposite.material.depthTest = false;
    this.worldComposite.material.depthWrite = false;
    this.spriteComposite = new ShaderPass(spriteCompositeShader);
    this.screenCopy = new ShaderPass({
      name: 'LayeredBokehScreenOutput', vertexShader,
      uniforms: { tColor: { value: null } },
      fragmentShader: 'varying vec2 vUv; uniform sampler2D tColor; void main() { gl_FragColor = texture2D(tColor, vUv); }',
    });
    this.screenCopy.renderToScreen = true;
    this.lens = this.worldBlur.uniforms;
    for (const pass of [this.worldComposite, this.spriteComposite]) {
      for (const key of Object.keys(lensUniforms())) pass.uniforms[key] = this.lens[key];
    }
    this.lens.focus.value = params.focus ?? 12;
    this.lens.tColor.value = this.sceneTarget.texture;
    this.lens.tDepth.value = this.sceneTarget.depthTexture;
    this.worldComposite.uniforms.tColor.value = this.sceneTarget.texture;
    this.worldComposite.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.worldComposite.uniforms.tBlur.value = this.blurTarget.texture;
    this.spriteComposite.uniforms.tSprite.value = this.spriteTarget.texture;
    this.spriteComposite.uniforms.tWorldDepth.value = this.sceneTarget.depthTexture;
    Object.assign(this.spriteComposite.material, {
      transparent: true, blending: CustomBlending,
      blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
      depthTest: false, depthWrite: false,
    });
    this._clearColor = new Color();
    this._point = new Vector3();
    this._bounds = new Box2();
    this._corner = new Vector2();
    this._zero = new Vector2();
    this._size = new Vector2(1, 1);
    this._worldDepth = { value: this.sceneTarget.depthTexture };
    this._resolution = { value: this._size };
    this.spriteComposite.uniforms.drawingSize.value = this._size;
  }

  addCharacter(character) {
    this.characters.push({ character, depth: 0, visible: false });
    character.group.layers.disable(0);
    character.group.layers.enable(1);
    character.plane.layers.set(1);
    const material = character.material;
    // SRC_ALPHA blending onto zero stores P=alpha*C and A=alpha in the target.
    material.premultipliedAlpha = false;
    const compileCharacter = material.onBeforeCompile;
    material.onBeforeCompile = shader => {
      compileCharacter(shader);
      shader.uniforms.courtyardDepth = this._worldDepth;
      shader.uniforms.drawingSize = this._resolution;
      shader.fragmentShader = `uniform sampler2D courtyardDepth;\nuniform vec2 drawingSize;\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          float courtyardZ = texture2D(courtyardDepth, gl_FragCoord.xy / drawingSize).r;
          if (gl_FragCoord.z > courtyardZ + 0.000001) discard;
        `);
    };
    material.customProgramCacheKey = () => 'courtyard-aligned-character-occlusion-v2';
    material.needsUpdate = true;
  }

  _spriteRect(plane, margin) {
    this._bounds.makeEmpty();
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
      this._point.set(x, y, 0).applyMatrix4(plane.matrixWorld).project(this.camera);
      this._corner.set((this._point.x * 0.5 + 0.5) * this._size.x,
        (this._point.y * 0.5 + 0.5) * this._size.y);
      this._bounds.expandByPoint(this._corner);
    }
    this._bounds.expandByScalar(margin);
    this._bounds.min.floor().max(this._zero);
    this._bounds.max.ceil().min(this._size);
    return this._bounds;
  }

  _radius(depth) {
    const u = this.lens;
    const difference = depth - u.focus.value;
    const near = difference < 0;
    const start = near ? u.nearClear.value : u.farClear.value;
    const range = near ? u.nearRange.value : u.farRange.value;
    const t = Math.max(0, Math.min(1, (Math.abs(difference) - start) / range));
    return u.strength.value * t * t * (3 - 2 * t) * (near ? u.nearBlur.value : u.farBlur.value);
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    const oldLayers = this.camera.layers.mask;
    const oldBackground = this.scene.background;
    const oldAlpha = renderer.getClearAlpha();
    const oldScissor = writeBuffer.scissor.clone();
    const oldScissorTest = writeBuffer.scissorTest;
    renderer.getClearColor(this._clearColor);
    for (const entry of this.characters) entry.visible = entry.character.plane.visible;
    try {
      this.lens.nearClip.value = this.camera.near;
      this.lens.farClip.value = this.camera.far;
      renderer.autoClear = true;
      this.camera.layers.set(0);
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(this.scene, this.camera);
      this.worldBlur.render(renderer, this.blurTarget, readBuffer);
      this.worldComposite.render(renderer, writeBuffer, readBuffer);
      this.scene.background = null;
      this.camera.layers.set(1);
      for (const entry of this.characters) {
        this._point.setFromMatrixPosition(entry.character.plane.matrixWorld).applyMatrix4(this.camera.matrixWorldInverse);
        entry.depth = -this._point.z;
        entry.character.plane.visible = false;
      }
      this.characters.sort((a, b) => b.depth - a.depth);
      for (const { character, visible, depth } of this.characters) {
        if (!visible || depth <= this.camera.near) continue;
        const radius = this._radius(depth);
        character.plane.visible = true;
        if (radius <= 0.35) {
          // Same lens rule, full-resolution sharp band. No temporary layer needed.
          renderer.autoClear = false;
          renderer.setRenderTarget(writeBuffer);
          renderer.render(this.scene, this.camera);
        } else {
          const margin = (radius + 2) * this._size.x / this.lens.viewport.value.x;
          const rect = this._spriteRect(character.plane, margin);
          if (rect.isEmpty()) { character.plane.visible = false; continue; }
          this.spriteTarget.scissor.set(rect.min.x, rect.min.y,
            rect.max.x - rect.min.x, rect.max.y - rect.min.y);
          this.spriteTarget.scissorTest = true;
          renderer.setClearColor(0x000000, 0);
          renderer.autoClear = true;
          renderer.setRenderTarget(this.spriteTarget);
          renderer.render(this.scene, this.camera);
          this.spriteComposite.uniforms.spriteDepth.value = depth;
          this.spriteComposite.uniforms.spriteBounds.value.set(
            rect.min.x / this._size.x, rect.min.y / this._size.y,
            rect.max.x / this._size.x, rect.max.y / this._size.y);
          writeBuffer.scissor.copy(this.spriteTarget.scissor);
          writeBuffer.scissorTest = true;
          renderer.autoClear = false;
          this.spriteComposite.render(renderer, writeBuffer, readBuffer);
          writeBuffer.scissorTest = false;
        }
        character.plane.visible = false;
      }
      if (this.renderToScreen) {
        this.screenCopy.uniforms.tColor.value = writeBuffer.texture;
        renderer.autoClear = true;
        this.screenCopy.render(renderer, writeBuffer, readBuffer);
      }
    } finally {
      for (const entry of this.characters) entry.character.plane.visible = entry.visible;
      writeBuffer.scissor.copy(oldScissor);
      writeBuffer.scissorTest = oldScissorTest;
      this.spriteTarget.scissorTest = false;
      this.camera.layers.mask = oldLayers;
      this.scene.background = oldBackground;
      renderer.setClearColor(this._clearColor, oldAlpha);
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget);
    }
  }

  setViewport(width, height) { this.lens.viewport.value.set(width, height); }
  setFocus(depth) { this.lens.focus.value = Math.max(this.camera.near, Math.min(this.camera.far, depth)); }

  setSize(width, height) {
    this._size.set(width, height);
    this.sceneTarget.setSize(width, height);
    this.spriteTarget.setSize(width, height);
    const blurWidth = Math.max(1, Math.floor(width * this.renderScale));
    const blurHeight = Math.max(1, Math.floor(height * this.renderScale));
    this.blurTarget.setSize(blurWidth, blurHeight);
    this.worldComposite.uniforms.blurSize.value.set(blurWidth, blurHeight);
  }

  dispose() {
    for (const target of [this.sceneTarget, this.blurTarget, this.spriteTarget]) target.dispose();
    for (const pass of [this.worldBlur, this.worldComposite, this.spriteComposite, this.screenCopy]) pass.dispose();
  }
}
