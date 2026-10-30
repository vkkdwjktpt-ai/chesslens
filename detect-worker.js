/* Runs the board finder off the main thread so scanning never stalls the camera view. */
importScripts('lens.js?v=4', 'detect.js?v=4');
onmessage = e => {
  const { id, buf, w, h } = e.data;
  const r = Detect.detectBoard(new Uint8ClampedArray(buf), w, h);
  postMessage({ id, quad: r && r.quad ? r.quad : null, score: r && r.score });
};
