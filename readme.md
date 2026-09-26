# Beam

A small, browser-only application that moves files and pasted text from a display to a camera through animated QR codes. No uploads, accounts, pairing, runtime CDN, or build dependencies.

## Use

1. Open the app on both devices. On the sender, select a document or any file of up to 10 MiB, or choose **Paste text** and enter text in any language.
2. On the receiver, choose **Receive a file**, grant camera access, and point it at the sender's code.
3. Start the signal. Keep the whole code in view. Use fullscreen or move closer if necessary.
4. Wait for **File verified**, then press **Save verified file**. For pasted text, you can also read and copy the verified text. Pause the sender manually afterward.

The sender repeats indefinitely. The receiver retains valid blocks across camera pauses and mode changes. A refresh or closed tab loses this in-memory progress. The sender has no feedback channel, so it cannot automatically know when the receiver has finished.

Start with the defaults: one code, balanced density, 10 fps. For more speed, open **Scan options**, select **Two · higher capacity**, and use fullscreen with both codes in view. If progress stalls, choose one code or a lower rate. Higher density needs a larger, sharper code. Changing density or editing text prepares a new transfer; clear the old transfer on the receiver first. Changing speed, code count, or pausing preserves the transfer identity.

## Run or host

The application lives directly in the repository root: plain HTML, CSS, JavaScript, and a bundled WebAssembly decoder. No build or package installation is needed.

For GitHub Pages, push these files to `master`, then select **Settings → Pages → Deploy from a branch → master → / (root) → Save**. The root `.nojekyll` file lets GitHub serve the bundled assets directly. All app URLs are relative, so both `https://user.github.io/beam/` and a custom domain work. See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

For a local desktop, Node 20+ can serve the files:

```sh
npm start
```

Then open `http://localhost:8080` on that computer. The included development server intentionally binds to loopback. For a second device, serve the static files at an HTTPS address that it can reach or run a local server on that device. `http://192.168.x.x` does not normally qualify for camera permission. Opening `index.html` directly as `file://` is not supported because worker and module policies differ across browsers. See [MDN's camera security requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security).

Load the app once on each device and wait for **Ready to reopen offline**. Its service worker caches the app and its runtime libraries. The transfer then works without a network connection. Browser cache eviction, private browsing, or service-worker restrictions may prevent later offline reopening. No file contents or camera frames are sent over a network.

An app update waits until all Beam tabs at that address close, so a transfer keeps using one release. Reopen after closing those tabs to apply it. Each hosted path has its own cache. When releasing changes to any cached asset, bump the cache version in `sw.js`.

## Minimal protocol

| Layer | Implementation |
| --- | --- |
| Visual encoding | One or two monochrome QR codes at a time, error correction M, a four-module quiet zone, and integer-pixel modules |
| Payload representation | Base45 in explicit QR alphanumeric mode, which avoids the reference's binary-to-UTF-8-to-Base64 expansion |
| Compression | Browser gzip, only when the compressed result is smaller; raw bytes otherwise |
| Identification | Random 64-bit transfer ID on every packet, protocol version, block index, block count, and block size |
| Corruption detection | CRC-32 over every packet header and payload; malformed packets are ignored |
| First pass | Indexed data blocks and one XOR parity block per eight data blocks; short single-block transfers use their small data frame |
| Loss recovery | Later passes send fresh XOR repair equations over groups of up to 16 blocks, shuffled to avoid fixed-rate sampling patterns |
| Bounded fountain decoder | Gaussian elimination retains only independent equations; at most 16 per group, discarded as blocks are solved |
| Late joining | File metadata repeats every 15 data/repair frames; up to 64 frames are buffered before metadata arrives |
| File verification | SHA-256 and the original byte length must match after decompression; only then is a download created |
| Camera decoding | Native BarcodeDetector when available, otherwise the local zbar-wasm decoder in a Web Worker; both codes are read from one camera frame, and at most one decode is in flight |
| Display pipeline | A second worker prepares up to six screen frames ahead of time. requestAnimationFrame displays them independently of QR generation; the displayed FPS is measured |

New senders use `B2:` followed by Base45. New receivers also accept old `B1:` transfers. Use the updated app on both devices to send B2; old receivers cannot read it. The decoded packet is big-endian:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 1 | Protocol version: 2 for new transfers, 1 for legacy reception |
| 1 | 1 | Type: 0 metadata, 1 data, 2 parity, 3 XOR repair (v2 only) |
| 2 | 8 | Transfer ID |
| 10 | 4 | Data index, parity group index, or repair descriptor; 0 for metadata |
| 14 | 4 | Number of data blocks |
| 18 | 2 | Block size: 384, 720, or 1024 bytes |
| 20 | variable | UTF-8 metadata JSON or payload bytes |
| final 4 | 4 | CRC-32 of all preceding packet bytes |

The metadata contains the filename, original size, transmitted size, `raw`/`gzip` encoding, original-file SHA-256, and a `file`/`text` kind. Pasted text becomes exact UTF-8 bytes in `message.txt`; it is never interpreted as HTML. The final data block may be short. Parity and repair treat short blocks as zero-padded and carry a full block. A zero-byte file uses one zero-length data block. The receiver validates indices, lengths, file limits, and decompressed output size before accepting a result. Filenames are displayed as text and path separators/control characters are removed from download names.

For type 3, the index's upper 16 bits select a group of 16 data blocks and the lower 16 bits select the blocks to XOR. Zero masks and bits outside the group are rejected. Later passes start with a full-rank basis randomized by elementary row operations, plus 12.5% extra repair frames. This allows lossless late joining without the initial data pass. A singleton group uses a short data frame. This is a small fountain-style random linear code, not an LT/Raptor implementation or RFC-compatible codec. It needs no acknowledgment channel or new dependency. Known blocks plus stored equation payloads are bounded by one padded copy of the transmitted file.

The progress bar counts independent pieces, including useful equations that have not yet solved individual blocks. **FILE DATA** and **DATA RATE** count reconstructed payload bytes, so they can advance in jumps while equations combine. Duplicates never advance progress.

## Performance and tradeoffs

Beam encodes two bytes into three Base45 characters, which QR alphanumeric mode packs efficiently. Compression saves bytes when useful; QR generation and the fallback camera decoder run in workers. Native QR detection reads video directly without a canvas copy.

For a sufficiently large file, nominal compressed-payload ceilings after parity and metadata overhead are:

| Configuration | Nominal payload ceiling | Ideal time for 1 MiB of transmitted data |
| --- | --- | --- |
| 1 code, 720 bytes, 10 fps | 6,000 bytes/s | 175 seconds |
| 2 codes, 720 bytes, 10 fps | 12,000 bytes/s | 87 seconds |
| 2 codes, 1024 bytes, 20 fps | 34,133 bytes/s | 31 seconds |
| 2 codes, 1024 bytes, 30 fps | 51,200 bytes/s | 20.5 seconds |

These are calculated ceilings, not measured optical throughput. Camera exposure, decoding time, screen resolution, and missed frames reduce them. The UI's **MAX. DATA RATE** is an ideal ceiling at the selected pace. **DATA RATE** measures reconstructed payload bytes over elapsed time, including camera pauses. A higher selected FPS does not necessarily finish a transfer sooner.

A local CPU-only run on a synthetic 452×452-pixel QR image carrying 720 payload bytes measured median decode times of **24.72 ms for jsQR versus 8.33 ms for zbar-wasm**, over 20 samples after five warm-up iterations. This compares decoders, not old versus new Beam or physical transfer speed. Run `node tests/benchmark.mjs` to measure on your machine.

The deterministic recovery benchmark compares the old shuffled-repeat schedule with the new repair schedule, including metadata overhead. Each scenario uses 20 trials of 256 blocks × 384 bytes, and every completed file passes SHA-256 verification:

| Simulated loss | Old mean frames sent | New mean frames sent | Reduction |
| --- | --- | --- | --- |
| 30% independent losses | 995.5 | 574.8 | 42.3% |
| Bursts averaging 5 frames, about 30% loss | 1,061.7 | 692.9 | 34.7% |

Run `node tests/recovery-benchmark.mjs` to reproduce these results. They measure packets needed for recovery, not physical optical throughput. Fixed groups keep memory and CPU bounded; a full-file fountain codec could have different overhead, but adds complexity. The [random linear coding discussion in RFC 8681](https://www.rfc-editor.org/rfc/rfc8681.html) provides background; Beam uses its own simpler wire format.

Actual screen-to-camera throughput has not been measured on physical devices here. Compression may help text substantially; ZIPs, PDFs, photos, and other compressed files often gain little. This tool is best for small files. Several MiB may take many minutes.

SHA-256 verifies recovery integrity against the transmitted metadata. It does not authenticate the sender. The optical channel is not encrypted: anyone who can see the codes can receive the file. The application keeps one transfer in memory and does not persist file content.

## Verification

Run the tests with Node 20+:

```sh
npm test
```

Tests cover byte-exact binary/text roundtrips, compression, empty files, legacy reception, multiple erasures, late joining, bounded repair memory, malformed packets, corruption, decompression limits, SHA-256 failure, and reset during verification. The bundled encoder and decoders roundtrip synthetic QR images at all densities, with rotation, small visual damage, and two simultaneous codes. Runtime tests cover camera cancellation, stale callbacks, wake locks, worker failures, and useful equation progress. Hosting tests cover root/subpath URLs, offline assets, update isolation, and failed installs.

Synthetic image and mocked lifecycle tests are not physical-camera tests. Before relying on a pair of devices, transfer a small known file, pause and resume the receiver, then try the intended document.

## Source layout

```text
index.html              Sender/receiver interface
styles.css              Responsive styles
app.js                  UI, camera lifecycle, display scheduler
protocol.js             Encoding, validation, loss recovery, SHA-256
encode-worker.js        Bounded QR preparation worker
decode-worker.js        Camera decoder worker
decoder.js              QR-only WASM decoder configuration
sw.js                   Offline app cache
vendor/                 QR encoder/decoder and their licenses
tests/protocol.test.mjs  Protocol and synthetic QR tests
tests/runtime.test.mjs   Camera and worker lifecycle regressions
tests/hosting.test.mjs   Offline and static hosting regressions
tests/benchmark.mjs      Reproducible decoder CPU comparison
tests/recovery-benchmark.mjs  Reproducible loss simulation
serve.mjs                Optional zero-dependency development server
```

## Attribution

This implementation uses the uploaded `airgapped-qr-code-transfer-master` project by Mohan Kumar as a reference for the screen-to-camera workflow. The Beam application code is a new implementation. The original project's MIT license is retained in `REFERENCE-LICENSE`.

Bundled dependencies, whose licenses remain alongside their files:

- [node-qrcode 1.4.4](https://github.com/soldair/node-qrcode), MIT, browser build. This pinned release includes the ready-to-use browser bundle.
- [zbar-wasm 0.11.0](https://github.com/undecaf/zbar-wasm), LGPL-2.1, unmodified browser bundle with inline WASM. Its license is included; the library can be replaced independently of Beam.
- [jsQR 1.4.0](https://github.com/cozmo/jsQR), Apache-2.0; retained as the test/benchmark baseline, not loaded by the app.

The app's original code is available under the MIT license in `LICENSE`.
