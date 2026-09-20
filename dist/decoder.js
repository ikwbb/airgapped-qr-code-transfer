import { scanImageData, getDefaultScanner, ZBarSymbolType, ZBarConfigType } from './vendor/zbar.mjs';
let ready;
export async function decodeImage(image) {
  ready ??= getDefaultScanner().then(scanner => {
    scanner.setConfig(ZBarSymbolType.ZBAR_NONE, ZBarConfigType.ZBAR_CFG_ENABLE, 0);
    scanner.setConfig(ZBarSymbolType.ZBAR_QRCODE, ZBarConfigType.ZBAR_CFG_ENABLE, 1);
  });
  await ready;
  return (await scanImageData(image)).map(symbol => symbol.decode()).filter(text => text.startsWith('B1:'));
}
