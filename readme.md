# Beam

A minimal, browser-only application that moves documents, arbitrary files, and pasted text from a display to a camera through animated QR codes. There is no file-transfer server, account system in the app, WebRTC connection, or runtime CDN dependency. The hosted preview may require the owner's sign-in; the downloadable app does not.

## Use

1. Open the app on both devices. On the sender, select a document or any file of up to 10 MiB, or choose **Paste text** and enter text in any language.
2. On the receiver, choose **Receive a file**, grant camera access, and point it at the sender's code.
3. Start the signal. Keep the whole code in view. Use fullscreen or move closer if necessary.
4. Wait for **File verified**, then press **Save verified file**. For pasted text, you can also read and copy the verified text. Pause the sender manually afterward.

The sender repeats indefinitely. The receiver retains valid blocks across camera pauses and mode changes. A refresh or closed tab loses this in-memory progress. The sender has no feedback channel, so it cannot automatically know when the receiver has finished.

Start with the balanced density at 10 fps. A wide screen starts with two codes; a narrow screen starts with one. For more speed, use **Two · higher capacity**, fullscreen, and a higher display rate, and keep both codes in view. If progress stalls, choose one code or a lower rate. Higher density needs a larger, sharper code. Changing density or editing text prepares a new transfer; clear the old transfer on the receiver first. Changing speed, code count, or pausing preserves the transfer identity.

## Run or host

`dist/` is the complete application: plain HTML, CSS, JavaScript, and a bundled WebAssembly decoder. Upload its contents to any HTTPS static host. No build or package installation is needed. WebAssembly runs inside the browser; it does not require a native app or a native binary installation.

For a local desktop, Node 20+ can serve the files:

```sh
npm start
```

Then open `http://localhost:8080` on that computer. The included development server intentionally binds to loopback. For a second device, serve the static files at an HTTPS address that it can reach or run a local server on that device. `http://192.168.x.x` does not normally qualify for camera permission. Opening `index.html` directly as `file://` is not supported because worker and module policies differ across browsers. See [MDN's camera security requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security).

Load the app once on each device and wait for **Ready to reopen offline**. Its service worker caches the app and both libraries. The transfer then works without a network connection. Browser cache eviction, private browsing, or service-worker restrictions may prevent later offline reopening. No file contents or camera frames are sent over a network. The source ZIP is not part of the offline cache.

## Minimal protocol

| Layer | Implementation |
| --- | --- |
| Visual encoding | One or two monochrome QR codes at a time, error correction M, a four-module quiet zone, and integer-pixel modules |
| Payload representation | Base45 in explicit QR alphanumeric mode, which avoids the reference's binary-to-UTF-8-to-Base64 expansion |
| Compression | Browser gzip, only when the compressed result is smaller; raw bytes otherwise |
| Identification | Random 64-bit transfer ID on every packet, protocol version, block index, block count, and block size |
| Corruption detection | CRC-32 over every packet header and payload; malformed packets are ignored |
| Loss recovery | Indexed blocks repeat; one XOR parity block per eight data blocks recovers any single erasure within that group |
| Additional losses | Later passes fill gaps without discarding previous blocks; each later pass is shuffled to reduce fixed-rate sampling patterns |
| Late joining | File metadata repeats every 15 data/repair frames; up to 64 frames are buffered before metadata arrives |
| File verification | SHA-256 and the original byte length must match after decompression; only then is a download created |
| Camera decoding | Native BarcodeDetector when available, otherwise the local zbar-wasm decoder in a Web Worker; both codes are read from one camera frame, and at most one decode is in flight |
| Display pipeline | A second worker prepares up to six screen frames ahead of time. requestAnimationFrame displays them independently of QR generation; the displayed FPS is measured |

Each frame is `B1:` followed by Base45. The decoded packet is big-endian:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 1 | Protocol version, currently 1 |
| 1 | 1 | Type: 0 metadata, 1 data, 2 parity |
| 2 | 8 | Transfer ID |
| 10 | 4 | Data index or parity group index; 0 for metadata |
| 14 | 4 | Number of data blocks |
| 18 | 2 | Block size: 384, 720, or 1024 bytes |
| 20 | variable | UTF-8 metadata JSON or payload bytes |
| final 4 | 4 | CRC-32 of all preceding packet bytes |

The metadata contains the filename, original size, transmitted size, `raw`/`gzip` encoding, original-file SHA-256, and a `file`/`text` kind. Pasted text becomes exact UTF-8 bytes in `message.txt`; it is never interpreted as HTML. The final data block may be short. Parity treats short blocks as zero-padded and is always a full block. A zero-byte file uses one zero-length data block. The receiver validates indices, lengths, file limits, and decompressed output size before accepting a result. Filenames are displayed as text and path separators/control characters are removed from download names.

## Performance and tradeoffs

The reference sends 250-byte chunks once with a nominal 50 ms delay, displays metadata only at startup, and has no whole-file cryptographic check. Its encoding turns random binary bytes into roughly twice as many text characters before QR byte-mode encoding. Beam encodes two bytes into three Base45 characters, which QR alphanumeric mode packs efficiently.

For a sufficiently large file, nominal compressed-payload ceilings after parity and metadata overhead are:

| Configuration | Nominal payload ceiling | Ideal time for 1 MiB of transmitted data |
| --- | --- | --- |
| 1 code, 720 bytes, 10 fps | 6,000 bytes/s | 175 seconds |
| 2 codes, 720 bytes, 10 fps | 12,000 bytes/s | 87 seconds |
| 2 codes, 1024 bytes, 20 fps | 34,133 bytes/s | 31 seconds |
| 2 codes, 1024 bytes, 30 fps | 51,200 bytes/s | 20.5 seconds |

These are calculated ceilings, not measured optical throughput. Camera exposure, decoding time, screen resolution, and missed frames reduce them. The UI's **MAX. DATA RATE** is an ideal ceiling at the selected pace. **RECEIVE RATE** measures distinct recovered payload bytes over elapsed time, which includes camera pauses. Do not equate a higher selected FPS with a faster completed transfer.

A local CPU-only benchmark on the same synthetic 452×452-pixel QR image with 720 payload bytes measured median decode times of **19.04 ms for jsQR versus 9.65 ms for zbar-wasm**, about **1.97× faster decoding** over 20 samples after five warm-up iterations. This isolates the decoder; it does not establish a 1.97× screen-to-camera transfer speedup. The pure-JavaScript baseline is retained for reproducibility. Run `node tests/benchmark.mjs` to measure on another machine.

Actual screen-to-camera throughput has not been measured on physical devices here, and this release does not claim a measured speedup over the supplied reference. Compression may help text substantially; ZIPs, PDFs, photos, and other compressed files often gain little. This tool is best for small files. Several MiB may take many minutes.

One lost block per parity group can be repaired immediately. Two or more missing blocks require a later repeat. This is deliberately simpler than a full fountain-code implementation and does not require a reverse camera or acknowledgment channel. Experimental color encodings were left out.

### Research that informed the changes

- [zbar-wasm](https://github.com/undecaf/zbar-wasm) supports workers and multiple barcodes per frame. Beam bundles its decoder and restricts it to QR to avoid unrelated scanning work.
- [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/) describes multiple simultaneous codes, fountain recovery, and a specialized decoder. Its maintainers report device-specific optical rates substantially above simple QR loops. Those results are **not Beam benchmarks**. Beam applies parallel codes and a bounded worker pipeline without copying that application's code or claiming its measured speeds.
- [Fountain codes and animated QR](https://divan.dev/posts/fountaincodes/) explains how repeated full passes increase completion time after losses. Beam uses lightweight parity plus persistent block collection; a full fountain codec remains a possible improvement if physical tests show that long repeat cycles dominate completion time.
- [libcimbar](https://github.com/sz3/libcimbar) reports approximately 106 KB/s with its custom color format, but its documented decoder is an Android app and its WASM support is encoder-only. That does not satisfy this application's browser-only receiver requirement.

SHA-256 verifies recovery integrity against the transmitted metadata. It does not authenticate the sender. The optical channel is not encrypted: anyone who can see the codes can receive the file. The application keeps one transfer in memory and does not persist file content.

## Verification

Run the tests with Node 20+:

```sh
npm test
```

The 12 automated tests cover byte-exact roundtrips, empty files, Unicode filenames and pasted text, compression, parity recovery, a bounded late-join buffer, repeated metadata, foreign sessions, duplicate and out-of-order packets, a deterministic stream with 30% frame loss and 10% corruption, limits on decompression, and a forged valid-CRC packet which must fail SHA-256. The actual bundled encoder and decoders also roundtrip synthetic QR raster images at all three densities, with 90-degree rotation, small visual damage, and two simultaneous codes.

All 12 tests passed in the implementation environment. JavaScript syntax, local asset references, unique HTML IDs, and direct UI element references were also checked. Synthetic image tests are not physical-camera tests. Interactive browser QA, real camera permission behavior, actual optical throughput, and the optional WebMCP integration have not been validated in a supported browser in this environment. Before relying on a particular pair of devices, transfer a small known file, pause and resume the receiver, then try the intended document.

## Source layout

```text
dist/index.html          Sender/receiver interface
dist/styles.css          Responsive styles
dist/app.js              UI, camera lifecycle, display scheduler
dist/protocol.js         Encoding, validation, parity, assembly, SHA-256
dist/encode-worker.js    Bounded QR preparation worker
dist/decode-worker.js    Camera decoder worker
dist/decoder.js          QR-only WASM decoder configuration
dist/sw.js               Offline app cache
dist/vendor/             QR encoder/decoder and their licenses
tests/protocol.test.mjs  Protocol and synthetic QR tests
tests/benchmark.mjs      Reproducible decoder CPU comparison
serve.mjs                Optional zero-dependency development server
```

## Attribution

This implementation uses the uploaded `airgapped-qr-code-transfer-master` project by Mohan Kumar as a reference for the screen-to-camera workflow. The Beam application code is a new implementation. The original project's MIT license is retained in `REFERENCE-LICENSE`.

Bundled dependencies, whose licenses remain alongside their files:

- [node-qrcode 1.4.4](https://github.com/soldair/node-qrcode), MIT, browser build. This pinned release includes the ready-to-use browser bundle.
- [zbar-wasm 0.11.0](https://github.com/undecaf/zbar-wasm), LGPL-2.1, unmodified browser bundle with inline WASM. Its license is included; the library can be replaced independently of Beam.
- [jsQR 1.4.0](https://github.com/cozmo/jsQR), Apache-2.0; retained as the test/benchmark baseline, not loaded by the app.

The app's original code is available under the MIT license in `LICENSE`.
