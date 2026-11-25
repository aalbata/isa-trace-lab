# Deployment and network use

## Static hosting

The production build in `dist/` is a set of static files. It needs no server
code, no database, no account, and no secret. Two choices make it independent
of the path it is served from:

- Vite builds with a relative base (`base: './'` in `vite.config.ts`), so all
  asset references are relative to `index.html`;
- pages are addressed by the URL fragment (`#/workspace`), so direct visits and
  reloads work on hosts that cannot rewrite paths, such as GitHub Pages.

`.github/workflows/pages.yml` builds the site from the tested source (type
check and unit tests run before the build) and deploys `dist/` with the
official GitHub Pages actions, pinned by commit. To use it, enable GitHub Pages
for the repository with "GitHub Actions" as the source. A project site is then
served under `https://<account>.github.io/<repository>/`.

`scripts/serve.mjs` serves `dist/` under a repository-style path for local
checks; the browser tests use it with the path `/isa-trace-lab/`.

## What is downloaded

Sizes of the version 1.0.0 build (uncompressed, and compressed with gzip at
level 9 as an indication of the transferred size):

| When | Files | Size | gzip |
| --- | --- | ---: | ---: |
| First visit | `index.html`, main script, style sheet | 1.14 MB | 0.36 MB |
| When a page that uses the compiler, assembler, decoder, or simulators is first opened | engine worker | 0.43 MB | 0.13 MB |
| When the CPython bytecode view is first opened | bytecode worker and Pyodide runtime: `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` | 13.5 MB | 6.3 MB |

The start page, the About page, and the architecture overview of the
instruction-set explorer need only the files of the first row. The other pages
also load the engine worker: the explorer's instruction pages and its
comparison of operations across targets, the code workspace, the
cross-architecture comparison, the assembler and decoder, and the exercises.

All files come from the same site as the application; nothing is loaded from
other hosts. The browser caches the files according to the host's headers. No
offline mode is claimed: the application has not been tested without a network
connection after the first visit.

## Browser requirements

The application uses ES2022 modules, module Web Workers, and WebAssembly (for
the CPython runtime only). It does not use `SharedArrayBuffer` and needs no
cross-origin isolation headers. A long simulation runs in slices in a worker; a
pause takes effect between slices, and if a run does not stop within 1.5 s the
worker is terminated and a new one is started. The browser tests run on Google
Chrome; other browsers were not tested.

## Data kept in the browser

The selected instruction set, the current program and its arguments, the
level of detail, the exercises already answered, and the counts of correctly
answered exercises are kept in the browser's local storage so that a visit can
be resumed. The About page has a button that clears them. No data is sent
anywhere.
