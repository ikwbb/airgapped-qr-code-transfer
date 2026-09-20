# Third-party components

Beam's original application code is MIT-licensed. Bundled libraries retain their own licenses.

- `qrcode.js`: node-qrcode 1.4.4, MIT. Copyright notices are in `QRCODE-LICENSE`. Source: https://github.com/soldair/node-qrcode.
- `zbar.mjs`: unmodified browser bundle from @undecaf/zbar-wasm 0.11.0, LGPL-2.1, which includes ZBar 0.23.90 compiled to WebAssembly. See `ZBAR-LICENSE`. Corresponding source is included in `source/zbar-wasm-0.11.0.tar.gz` (upstream commit c04ab59682681e27a24b36b36084806437a5d224) and `source/zbar-0.23.90.tar.gz`. The wrapper source includes its Makefile and build instructions. Upstream: https://github.com/undecaf/zbar-wasm. The decoder is a separate import that can be modified or replaced; reverse engineering for debugging library modifications is not restricted. Rebuilding this dependency is optional and is not required to run Beam.
- `jsQR.js`: jsQR 1.4.0, Apache-2.0. Copyright and license notices are in `JSQR-LICENSE`. Source: https://github.com/cozmo/jsQR. This is a test and benchmark baseline; the application does not load it.

No dependencies are loaded from a CDN at runtime. The source archives are included for modification and redistribution, and are not needed by the running browser app or its offline cache.
