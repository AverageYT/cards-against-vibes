import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStage } from '../src/visuals/stage.js';

function harness({ black = false, failShader = false, throwUpload = false } = {}) {
  const calls = { params: [], uploads: [], pixelation: [], reads: 0 };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, TEXTURE_MIN_FILTER: 9,
    TEXTURE_MAG_FILTER: 10, TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, NEAREST: 13,
    LINEAR: 14, CLAMP_TO_EDGE: 15, RGBA: 16, UNSIGNED_BYTE: 17, COLOR_BUFFER_BIT: 18, TRIANGLE_STRIP: 19,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
    getShaderParameter: () => !failShader, getProgramParameter: () => true,
    getAttribLocation: () => 0, getUniformLocation: (_p, name) => name,
    texParameteri: (...args) => calls.params.push(args),
    texImage2D: (...args) => { if (throwUpload) throw Error('upload failed'); calls.uploads.push(args); },
    uniform1f: (name, value) => { if (name === 'uPixelation') calls.pixelation.push(value); },
    readPixels: (_x, _y, _w, _h, _f, _t, data) => { calls.reads++; data[0] = black ? 0 : 80; },
  };
  for (const name of ['shaderSource','compileShader','deleteShader','attachShader','linkProgram','useProgram','bindBuffer','bufferData','enableVertexAttribArray','vertexAttribPointer','bindTexture','viewport','clearColor','clear','uniform1i','uniform2f','drawArrays','deleteProgram','deleteBuffer','deleteTexture']) gl[name] = () => {};
  const twoD = () => ({ save(){}, restore(){}, scale(){}, beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, ellipse(){}, rect(){}, clip(){}, fill(){}, fillRect(){}, drawImage(){}, putImageData(){},
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (_x,_y,w,h) => ({ data: new Uint8ClampedArray(w*h*4) }),
    createImageData: (w,h) => ({ data: new Uint8ClampedArray(w*h*4) }) });
  let n = 0, callback;
  const doc = { hidden: false, addEventListener(){}, removeEventListener(){}, createElement() {
    const index = n++; let type = null, ctx = twoD();
    return { width: 0, height: 0, attrs: {}, setAttribute(k,v){this.attrs[k]=v}, getAttribute(k){return this.attrs[k]},
      getContext(kind) { if (kind === 'webgl' && index === 1) { type = 'webgl'; return gl; }
        if (kind === '2d' && type !== 'webgl') { type='2d'; return ctx; } return null; } };
  }};
  const container = { clientWidth: 320, clientHeight: 180, children: [],
    appendChild(c){this.children.push(c);c.parentNode=this}, replaceChild(next,old){this.children[this.children.indexOf(old)]=next; old.parentNode=null;next.parentNode=this}, removeChild(c){this.children.splice(this.children.indexOf(c),1);c.parentNode=null} };
  const stage = mountStage({ doc, container, raf: cb => (callback=cb,1), caf:()=>{} });
  return { stage, calls, container, tick: now => callback(now) };
}

test('NPOT uploads use clamp and appropriate filters in both modes', () => {
  const { stage, calls, tick } = harness();
  assert.equal(stage.mode, 'webgl');
  assert.deepEqual(calls.uploads[0].slice(3,5), [320,180]);
  assert.ok(calls.uploads[0][8] instanceof Uint8ClampedArray);
  stage.setSettings({ pixelation: false }); tick(50);
  assert.deepEqual(calls.uploads.at(-1).slice(3,5), [640,360]);
  assert.deepEqual(calls.pixelation, [1,0]);
  assert.ok(calls.params.some(([,,value]) => value === 14), 'linear filter in soft mode');
  assert.ok(calls.params.filter(([,_key,value]) => value === 15).length >= 4, 'both axes clamp after uploads');
  assert.equal(calls.reads, 2, 'read back after both NPOT sizes');
  stage.dispose();
});

test('black frames, upload failure and shader failure fall back on a fresh 2D canvas', () => {
  for (const options of [{ black: true }, { failShader: true }, { throwUpload: true }]) {
    const { stage, container } = harness(options);
    assert.equal(stage.mode, 'software');
    assert.equal(container.children.length, 1);
    assert.equal(stage.canvas.getAttribute('aria-hidden'), 'true');
    stage.dispose();
    assert.equal(container.children.length, 0);
  }
});
