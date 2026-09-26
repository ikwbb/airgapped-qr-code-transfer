import { scanImageData, getDefaultScanner, ZBarSymbolType, ZBarConfigType } from './vendor/zbar.mjs';
let ready;
export async function decodeImage(image) {
  ready ??= getDefaultScanner().then(scanner => {
    scanner.setConfig(ZBarSymbolType.ZBAR_NONE, ZBarConfigType.ZBAR_CFG_ENABLE, 0);
    scanner.setConfig(ZBarSymbolType.ZBAR_QRCODE, ZBarConfigType.ZBAR_CFG_ENABLE, 1);
    return scanner;
  });
  return (await scanImageData(image, await ready)).map(symbol => symbol.decode()).filter(text => /^B[12]:/.test(text));
}
