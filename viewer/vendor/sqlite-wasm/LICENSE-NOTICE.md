SQLite Wasm (@sqlite.org/sqlite-wasm 3.54.1-build1)
SQLite itself is public domain; the ES Module wrapper is Apache-2.0.
https://github.com/sqlite/sqlite-wasm

Vendored files: sqlite3.js (= dist/index.mjs, renamed so any static host serves it as
JavaScript), sqlite3.wasm.
sqlite3.js resolves the .wasm with new URL("sqlite3.wasm", import.meta.url),
so the two must stay side by side.
