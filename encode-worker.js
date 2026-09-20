importScripts('./vendor/qrcode.js');
self.onmessage = ({ data }) => {
  try {
    const codes = data.texts.map(text => {
      const { modules } = QRCode.create([{ data: text, mode: 'alphanumeric' }], { errorCorrectionLevel: 'M' });
      return { size: modules.size, data: modules.data };
    });
    self.postMessage({ generation: data.generation, codes, label: data.label, pass: data.pass }, codes.map(code => code.data.buffer));
  } catch (error) {
    self.postMessage({ generation: data.generation, error: error.message });
  }
};
