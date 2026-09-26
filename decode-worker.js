import { decodeImage } from './decoder.js';
// Only one frame is in flight. The bundled WASM finds both codes in one pass.
self.onmessage = async ({ data }) => {
  try {
    const texts = await decodeImage({ data: new Uint8ClampedArray(data.buffer), width: data.width, height: data.height });
    self.postMessage({ texts, generation: data.generation });
  } catch (error) {
    self.postMessage({ texts: [], error: error.message, generation: data.generation });
  }
};
