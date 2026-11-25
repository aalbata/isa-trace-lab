# Contributing

Bug reports, corrections to instruction descriptions, and new back ends are
welcome through the issue tracker and pull requests of the repository.

## Reporting a defect

Please include the target, the program or the assembly text or bytes, the
arguments, what you observed, and what the architecture manual or the language
specification says should happen. An exported compiled-program or trace
document is the most useful attachment.

## Making a change

1. `npm ci`, then `npm run typecheck` and `npm test` must pass.
2. For interface changes, `npm run build` and `npm run test:browser` must pass.
   The browser tests run in the installed Google Chrome; without Chrome, run
   `npx playwright install chromium` once and set `PW_CHANNEL=bundled`, as
   described in the [README](README.md).
3. The recorded validation results are tied to the files that the validation
   reads or executes: the core (`src/core/`), the validation scripts with
   `scripts/lib/`, the harness and its corpus (`validation/` without its
   `results/` and `work/` folders), the example programs, and `package.json`,
   `package-lock.json`, and `tsconfig.json`. The source manifest hashes exactly
   these files; section 5 of [docs/validation.md](docs/validation.md) gives the
   list. After a change to any of them, run the independent validation with
   `node scripts/validate-all.mjs --per-family 200` and commit what it
   regenerates together with the change: `validation/results/`,
   `docs/validation-results.md`, `src/app/data/support-matrix.json`, and
   `docs/coverage.md`. Until then the continuous-integration job
   `recorded-results` fails, because the recorded results do not identify the
   changed files. Report the summary lines of the run. A change to any other
   file, such as the documentation, the browser application, or the tests,
   needs no new run.
4. Instruction descriptions are written for this project and cite the section
   of the specification that defines the instruction. Do not copy text from the
   manuals.

## Adding a back end

Follow [docs/backend-guide.md](docs/backend-guide.md). A back end is complete
when the cross-engine tests and every stage of the reference-tool comparison
pass with zero failures and every exclusion has a documented reason.
