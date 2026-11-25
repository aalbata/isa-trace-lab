# Performance measurements

`node scripts/benchmark.ts` measures the headless core in Node.js and writes
`experiments/results/benchmark.json`:

- cold compilation: the first compilation in a fresh process, per target;
- warm compilation: each example program for each target, after warm-up, repeated;
- simulation throughput: executed instructions per second on three long programs, for plain
  stepping, stepping with a recorded step event per instruction, and trace recording;
- CPython bytecode: loading the Pyodide runtime once, then disassembling each example, repeated.

`node scripts/benchmark-browser.mjs` (after `npm run build`) measures the application in Google
Chrome on the production build served from `localhost` and writes
`experiments/results/benchmark-browser.json`: cold start of the workspace in an empty cache,
first opening of the bytecode view, the latency of one instruction step including rendering, and
the time of a long run. The environment variable `PW_CHANNEL` selects another browser, as for the
browser tests; the file names the browser that was measured.

Both files record the hardware, operating system, runtime versions, number of repetitions, and
timing method. Times depend on the machine and are not comparable with measurements of real
processors; instruction counts and simulation throughput say nothing about the speed of the
architectures themselves.

## Figures and listings of the software article

`scripts/figures/` holds the scripts that produce the figures of the article from the files above:

    node scripts/figures/figure-data.ts            # experiments/results/figure-data.json
    pip install -r scripts/figures/requirements.txt
    python scripts/figures/figures.py              # architecture, validation, encodings, alignment, throughput (PDF)
    npm run build
    node scripts/figures/screenshots.mjs           # workspace.png from the production build in Google Chrome

The output goes to `experiments/figures/`. `figure-data.json` records, for the example programs used in the
article, the compiled listing on each target, the outcome and metrics of one run, the instruction index of
every statement boundary, the comparison verdict, and the decoded fields of the array load of
`examples/array_traversal.py`.
