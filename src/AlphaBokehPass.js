import { DepthTexture, HalfFloatType, UnsignedIntType, WebGLRenderTarget } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';

export class AlphaBokehPass extends ShaderPass {
  constructor(scene, camera, characterScene, params = {}) {
    super(BokehShader);
    this.scene = scene;
    this.camera = camera;
    this.characterScene = characterScene;
    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'DOF scene color';
    this.sceneTarget.depthTexture.name = 'DOF alpha-tested scene depth';
    this.material.defines.DEPTH_PACKING = 0;
    this.uniforms.tColor.value = this.sceneTarget.texture;
    this.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.uniforms.focus.value = params.focus ?? 15;
    this.uniforms.aperture.value = params.aperture ?? 0.0016;
    this.uniforms.maxblur.value = params.maxblur ?? 0.009;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.sceneTarget);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      // Retain the world's depth for occlusion. Sprite alphaTest discards transparent
      // texels from both color and native depth; shadows keep depthWrite disabled.
      renderer.render(this.characterScene, this.camera);
      this.uniforms.nearClip.value = this.camera.near;
      this.uniforms.farClip.value = this.camera.far;
      super.render(renderer, writeBuffer, readBuffer);
    } finally {
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget);
    }
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    this.uniforms.aspect.value = width / height;
  }

  dispose() {
    this.sceneTarget.dispose();
    super.dispose();
  }
}
