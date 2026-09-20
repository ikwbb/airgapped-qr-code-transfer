# Decoder corresponding source

These archives are for modifying or rebuilding the optional decoder dependency. Running Beam requires no compiler, C/C++ installation, or native application.

- `zbar-wasm-0.11.0.tar.gz`: https://github.com/undecaf/zbar-wasm/tree/c04ab59682681e27a24b36b36084806437a5d224, which is the `gitHead` recorded for npm @undecaf/zbar-wasm 0.11.0. The archive includes the C wrapper, TypeScript bindings, package lock, Makefile, and build/test instructions.
- `zbar-0.23.90.tar.gz`: https://github.com/mchehab/zbar/tree/0.23.90. This is the upstream library version named by that wrapper's Makefile.

The upstream Makefile expects a release tarball with generated configure files. For this source-tag archive, extract it into the wrapper checkout as `zbar-0.23.90` and run `autoreconf -vfi` there first if `configure` is absent. Then follow the wrapper's README and Makefile, which specify Emscripten 3.1.44 and the build flags. A modified inlined ES-module build can replace `dist/vendor/zbar.mjs` independently of the rest of Beam. The WASM is embedded in that module, so there is no separate binary to update.

See the bundled `../ZBAR-LICENSE` and the license notices inside each source archive.
