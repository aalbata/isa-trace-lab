/**
 * Summarize the validation results into tables. Every number is read from the
 * result files in validation/results; nothing is typed by hand.
 *
 *   node scripts/summarize-validation.ts [--results validation/results] [--check] [--partial]
 *
 * Writes <results>/summary.json, docs/validation-results.md, and the
 * per-instruction support matrix shown by the application
 * (src/app/data/support-matrix.json). With --check, nothing is written: the
 * three files are generated in memory and compared with the files on disk
 * (line endings and the date of the support matrix aside), and the process
 * exits with 1 when any of them differs, so a hand edit or a summary that was
 * not regenerated is detected.
 *
 * The summary recomputes the combined hash of the source tree
 * (scripts/source-manifest.mjs) and summarizes only results of that tree. It
 * writes nothing and exits with 1 when a result file records another hash or
 * none, when a result file has another format than the one this summary
 * reads, or when a result file is missing: the recorded manifest, the
 * cross-engine agreement, the semantics comparison, or a stage of a target.
 * With --partial, missing result files are named in the summary instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { availableBackends } from '../src/core/target/index.ts';
import { repoRoot } from './lib/corpus.ts';
import { sourceManifest } from './lib/source-tree.ts';

const root = repoRoot();
const argv = process.argv.slice(2);
const optionValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};
const check = argv.includes('--check');
const partial = argv.includes('--partial');
const results = resolve(root, optionValue('results') ?? join('validation', 'results'));
// The format of the result files of validation/run_validation.py that this summary reads.
const RESULT_FORMAT = 4;
// The JSON files have many shapes; they are read as untyped records.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const read = (...parts: string[]): Json | null => {
  const p = join(results, ...parts);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const fmt = (n: number | undefined | null): string => (n === undefined || n === null ? 'n/a' : n.toLocaleString('en-US'));
/** A number that a result file must contain; a missing one stops the summary instead of printing n/a. */
const need = (n: number | undefined | null, what: string): string => {
  if (typeof n !== 'number') throw new Error(`the result files do not record ${what}; run the stage that writes it again`);
  return fmt(n);
};

// The source tree as it is now. Every stage computed this hash when it started and recorded it in its result file.
const tree = sourceManifest();
const manifest = read('source-manifest.json');
const crosscheck = read('crosscheck.json');
const semantics = read('semantics.json');
const targets = availableBackends().map((b) => b.profile.id);
const stages = ['encoding', 'decoding', 'execution', 'programs'] as const;
const perTarget: Record<string, Record<string, Json>> = {};
for (const t of targets) {
  perTarget[t] = {};
  for (const s of stages) perTarget[t]![s] = read(t, `${s}.json`);
}
// Every result file: the name of what it holds, the hash of the source tree that it records, and whether it has the
// result format of validation/run_validation.py.
const resultFiles: { name: string; file: string; json: Json | null; source: unknown; formatted: boolean }[] = [
  { name: 'source manifest', file: 'source-manifest.json', json: manifest, source: manifest?.sha256, formatted: false },
  { name: 'cross-engine agreement', file: 'crosscheck.json', json: crosscheck, source: crosscheck?.source, formatted: false },
  { name: 'semantics', file: 'semantics.json', json: semantics, source: semantics?.source, formatted: true },
  ...targets.flatMap((t) => stages.map((s) => ({ name: `${t} ${s}`, file: `${t}/${s}.json`, json: perTarget[t]![s], source: perTarget[t]![s]?.source, formatted: true }))),
];
const refusals: string[] = [];
for (const r of resultFiles) {
  if (!r.json) continue;
  const path = relative(root, join(results, r.file)).split('\\').join('/');
  if (r.formatted && r.json.format !== RESULT_FORMAT) {
    // A result file of another format, written by another version of the harness, lacks numbers that this summary
    // reads or gives them another meaning.
    refusals.push(`${path} has result format ${r.json.format ?? 1}, and this summary reads format ${RESULT_FORMAT}; run the stage again`);
  } else if (r.source !== tree.sha256) {
    // A result of another source tree says nothing about this one.
    refusals.push(`${path} records the source tree ${typeof r.source === 'string' ? r.source : '(none)'}, and the source tree is now ${tree.sha256}`);
  }
}
// A missing result file is a stage that did not run, so a comparison or a target that was skipped cannot pass
// unnoticed. A partial summary, asked for with --partial, names the missing results instead.
const missing = resultFiles.filter((r) => !r.json).map((r) => r.name);
if (missing.length > 0 && !partial) refusals.push(`no result file for: ${missing.join('; ')}`);
if (refusals.length > 0) {
  for (const line of refusals) console.error(line);
  console.error('no summary was written; node scripts/validate-all.mjs produces every result of the source tree');
  process.exit(1);
}

const lines: string[] = [];
const P = (s = ''): void => {
  lines.push(s);
};
P('# Validation results');
P();
P('This file is generated by `node scripts/summarize-validation.ts` from the JSON files in `validation/results/`. Do not edit it by hand.');
P();
P(`Evaluated source tree: the ${fmt(tree.files)} files of the source manifest (\`docs/validation.md\`, section 5), combined SHA-256 \`${tree.sha256}\`. Every result summarized here records this hash${manifest ? '; `validation/results/source-manifest.json` lists the files' : ''}.`);
const tools = perTarget[targets[0]!]?.encoding?.tools ?? semantics?.tools;
if (tools) {
  P();
  P(`Reference tools (installed package versions): ${tools.clang} from the ziglang ${tools.ziglang} package; Capstone ${tools.capstone}${tools.capstone_core ? ` (core library ${tools.capstone_core})` : ''}; Unicorn ${tools.unicorn}; pyelftools ${tools.pyelftools}; Python ${tools.python}.`);
}
P();
if (missing.length > 0) {
  P('## Missing results');
  P();
  P(`This summary is partial. No result file was found for: ${missing.join('; ')}.`);
  P();
}

if (crosscheck) {
  const c = crosscheck;
  P('## Cross-engine agreement');
  P();
  P(`Engines: ${c.engines.join(', ')}. Corpus: ${fmt(c.corpus.programs)} programs (generator version ${c.corpus.generatorVersion}, initialization values ${c.corpus.firstInit} to ${c.corpus.firstInit + c.corpus.programsPerFamily - 1} for each of the five families), ${fmt(c.totals.runs)} runs.`);
  P('A run passes when every engine reaches the same outcome as the reference evaluator and the same statement, variable values, array contents, and output length at every boundary, and no engine stops at its step limit.');
  P('A run without a disagreement in which an engine stopped at its step limit is incomplete: it was compared only on the boundaries reached, so it is counted on its own, never as passed, and it fails the comparison. The last column counts the runs in which the reference evaluator stopped at its statement limit.');
  P();
  P('| Program group | Programs | Runs | Passed | Incomplete | Ended normally | Runtime error | Step limit |');
  P('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [g, v] of Object.entries(c.byGroup as Record<string, Json>)) {
    P(`| ${g} | ${fmt(v.programs)} | ${fmt(v.runs)} | ${fmt(v.passed)} | ${need(v.incomplete, `the incomplete runs of the group ${g}`)} | ${fmt(v.exited)} | ${fmt(v.trap)} | ${fmt(v.limit)} |`);
  }
  P(`| total | ${fmt(c.corpus.programs)} | ${fmt(c.totals.runs)} | ${fmt(c.totals.passed)} | ${need(c.totals.incomplete, 'the incomplete runs')} | | | |`);
  P();
  P('| Target | Runs | Agreeing runs | Incomplete runs | Instructions executed | Boundaries compared |');
  P('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [t, v] of Object.entries(c.perTarget as Record<string, Json>)) {
    P(`| ${t} | ${need(v.runs, `the runs of ${t}`)} | ${need(v.agreed, `the agreeing runs of ${t}`)} | ${need(v.incomplete, `the incomplete runs of ${t}`)} | ${need(v.instructions, `the instructions of ${t}`)} | ${need(v.boundaries, `the boundaries compared on ${t}`)} |`);
  }
  P();
}

if (semantics) {
  const s = semantics.totals;
  P('## Language semantics against an independent evaluator');
  P();
  P('The Python evaluator in `validation/reference_eval.py` is written from the language specification, parses programs with CPython\'s `ast` module, and shares no code with the TypeScript implementation.');
  P('Runs whose exact intermediate values all stay in the signed 32-bit range are also executed directly by CPython.');
  P();
  P('| Runs | Python evaluator agrees | IR interpreter agrees | Run directly in CPython | CPython agrees | Not comparable with CPython (wraparound or runtime error) |');
  P('| ---: | ---: | ---: | ---: | ---: | ---: |');
  P(`| ${fmt(s.runs)} | ${fmt(s.python_reference_agrees)} | ${fmt(s.ir_agrees)} | ${fmt(s.cpython_direct_runs)} | ${fmt(s.cpython_direct_agrees)} | ${fmt(s.not_compared_with_cpython)} |`);
  P();
}

P('## Encoding (Clang integrated assembler and LLD)');
P();
P('Programs are assembled and linked at the code base address; the bytes of the `.text` section must equal the bytes produced by this tool.');
P('A pseudoinstruction program whose bytes differ is compared line by line. Clang assembles each line for the address that the line has in this tool\'s program, and its bytes of the whole text must be its bytes of the lines in source order. An expansion that differs from Clang\'s choice is accepted only when both straight-line sequences, run in Unicorn at the address of the line, leave every register, every flag, and every byte of the data region, the stack region, and the code region outside the two sequences equal from each of several initial states, in which the registers hold zero, one, all ones, the most negative or most positive value (all the same value, or two different values arranged so that any two registers take any two of them), or pseudo-random values. The program\'s bytes must then equal Clang\'s bytes of its lines in source order, with this tool\'s expansion in place of Clang\'s for each accepted line.');
P('Instruction counts leave out data directives, such as the padding that places branch targets.');
P();
P('| Target | Sweep programs | Sweep instructions | Compiled programs | Compiled instructions | Programs identical | Equivalent pseudoinstruction expansions | Failures |');
P('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const t of targets) {
  const e = perTarget[t]!.encoding;
  if (!e) continue;
  const sw = e.summary.sweep ?? {};
  const ps = e.summary.pseudo ?? {};
  const co = e.summary.compiled ?? {};
  const progs = (sw.programs ?? 0) + (ps.programs ?? 0) + (co.programs ?? 0);
  const passed = (sw.programs_passed ?? 0) + (ps.programs_passed ?? 0) + (co.programs_passed ?? 0);
  const equivPrograms = (ps.equivalent_but_not_identical ?? 0) + (sw.equivalent_but_not_identical ?? 0);
  P(`| ${t} | ${fmt((sw.programs ?? 0) + (ps.programs ?? 0))} | ${fmt((sw.instructions ?? 0) + (ps.instructions ?? 0))} | ${fmt(co.programs)} | ${fmt(co.instructions)} | ${fmt(passed - equivPrograms)} of ${fmt(progs)} | ${fmt(ps.expansions_equivalent ?? 0)} | ${fmt(e.failure_count)} |`);
}
P();

P('## Decoding (reassembly by Clang, disassembly by Capstone)');
P();
P('Random 32-bit words (fixed-length targets) or random 15-byte strings (x86-64) are decoded. Accepted encodings are reassembled from the decoded text and must give the same bytes, or bytes that Capstone disassembles to the same instruction; Capstone must name the same instruction.');
P('On x86-64, a relative branch or call whose reassembled bytes differ is assembled again at its original address, where earlier instructions of different length cannot move it, and counts as identical when Clang then gives the original bytes.');
P('Rejections are checked in two ways: an encoding rejected as invalid must not be an implemented instruction in Capstone, where the implemented instructions are Capstone\'s names for the encodings of the instruction sweeps; and for every rejected encoding that Capstone decodes, this tool\'s own assembler must not produce those bytes from Capstone\'s text, including the short form of a jump.');
P('A rejection as unsupported that Capstone does not decode cannot be checked in either way. These rejections are counted in a column of their own; where the target entry of the harness states which of them are defined encodings, any other one is a failure.');
P();
P('| Target | Cases | Accepted | Identical on reassembly | Equivalent on reassembly | Alternate encodings checked | Capstone names the same instruction | Rejected as invalid | Rejected as unsupported | Of which not decoded by Capstone | Rejected encodings reproduced by the assembler of this tool | Failures |');
P('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const t of targets) {
  const d = perTarget[t]!.decoding;
  if (!d) continue;
  const x = d.totals;
  P(`| ${t} | ${fmt(x.cases)} | ${fmt(x.accepted)} | ${fmt(x.reassembled_equal)} | ${fmt(x.reassembled_equivalent)} | ${fmt(x.equivalent_alternate)} | ${fmt(x.capstone_same_mnemonic)} | ${fmt(x.rejected_as_invalid)} | ${fmt(x.rejected_as_unsupported)} | ${need(x.rejected_as_unsupported_not_decoded_by_capstone, `the rejections of ${t} as unsupported that Capstone does not decode`)} | ${fmt(x.rejected_checked_by_reencoding - x.rejected_not_encodable_by_this_tool)} of ${fmt(x.rejected_checked_by_reencoding)} | ${fmt(d.failure_count)} |`);
}
P();

P('## Instruction execution (Unicorn)');
P();
P('Each implemented instruction of the sweeps, the service instruction included, is executed from four random initial states in this tool and in Unicorn; registers, flags not left undefined by the architecture, the full-width program counter, and every byte of the 64 KiB data region and the 64 KiB stack region must match. Both regions start filled with bytes that depend on their address.');
P('A case that Unicorn cannot model in one respect is compared in every other respect and counted among the cases as partially compared; the reasons are listed under the exclusions below.');
P();
P('| Target | Cases | Passed | Of which both fault | Of which partially compared | Excluded | Failures |');
P('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const t of targets) {
  const x = perTarget[t]!.execution;
  if (!x) continue;
  P(`| ${t} | ${fmt(x.totals.cases)} | ${fmt(x.totals.passed)} | ${fmt(x.totals.faults_agreed)} | ${need(x.totals.partially_compared, `the partially compared cases of ${t}`)} | ${fmt(x.totals.excluded)} | ${fmt(x.failure_count)} |`);
}
P();

P('## Compiled programs (Unicorn)');
P();
P('Compiled corpus programs run in Unicorn with every argument tuple of the corpus and the same services; output, return value or error code, the number of executed instructions, the final data region, and the registers that hold source variables must match.');
P();
P('| Target | Runs | Passed | Ended normally | Runtime error | Instructions executed | Failures |');
P('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const t of targets) {
  const x = perTarget[t]!.programs;
  if (!x) continue;
  P(`| ${t} | ${fmt(x.totals.runs)} | ${fmt(x.totals.passed)} | ${fmt(x.totals.exited)} | ${fmt(x.totals.trap)} | ${fmt(x.totals.instructions_executed)} | ${fmt(x.failure_count)} |`);
}
P();

P('## Exclusions and documented differences');
P();
for (const t of targets) {
  const d = perTarget[t]!.decoding;
  const x = perTarget[t]!.execution;
  const notes: string[] = [];
  for (const [reason, n] of Object.entries((d?.exclusions ?? {}) as Record<string, number>)) notes.push(`Decoding: ${fmt(n)} encoding(s) accepted by Capstone but not by this tool: ${reason}.`);
  if (d?.totals.reassembled_equal_at_original_address) {
    notes.push(`Decoding: ${fmt(d.totals.reassembled_equal_at_original_address)} accepted relative branches and calls give the original bytes when Clang assembles them at their original address; they are counted as identical on reassembly.`);
  }
  if (d?.totals.reassembled_equivalent) notes.push(`Decoding: ${fmt(d.totals.reassembled_equivalent)} accepted encodings are valid non-canonical forms; Clang re-encodes the decoded text canonically and Capstone disassembles both forms to the same instruction.`);
  const defined = (d?.unsupported_not_decoded_by_capstone?.defined ?? {}) as Record<string, number>;
  for (const [reason, n] of Object.entries(defined)) notes.push(`Decoding: ${fmt(n)} encoding(s) rejected as unsupported that Capstone does not decode: ${reason}.`);
  // A reason that the target entry lists as a partial exclusion leaves the case in the comparison; any other reason excludes it.
  const partly = (x?.partially_compared ?? {}) as Record<string, number>;
  for (const [reason, n] of Object.entries((x?.exclusions ?? {}) as Record<string, number>)) {
    notes.push(partly[reason] === n
      ? `Execution: ${fmt(n)} case(s) compared in every respect that this reason does not affect: ${reason}.`
      : `Execution: ${fmt(n)} case(s) excluded: ${reason}.`);
  }
  if (notes.length > 0) {
    P(`### ${t}`);
    P();
    for (const n of notes) P(`- ${n}`);
    P();
  }
}

// The files this summary writes, or with --check compares; `dated` marks the one that records the date of the summary.
const outputs: { path: string; text: string; dated?: boolean }[] = [{ path: join(root, 'docs', 'validation-results.md'), text: lines.join('\n') }];

// ---- support matrix for the application ------------------------------------------
const matrix: { generated: string; source: string; targets: Record<string, Record<string, { compilerGenerates: boolean; assemblerChecked: number; emulatorChecked: number }>> } = {
  generated: new Date().toISOString().slice(0, 10),
  source: tree.sha256,
  targets: {},
};
for (const b of availableBackends()) {
  const t = b.profile.id;
  const enc = (perTarget[t]!.encoding?.by_mnemonic ?? {}) as Record<string, Record<string, number>>;
  // Instances of pseudoinstructions and aliases, counted by the name written in the source of the program.
  const pseudo = (perTarget[t]!.encoding?.by_pseudo ?? {}) as Record<string, Record<string, number>>;
  const exe = (perTarget[t]!.execution?.by_mnemonic ?? {}) as Record<string, { passed: number }>;
  const key = (m: string): string => (t === 'aarch64' && /^b\.\w+$/.test(m) ? 'b.cond' : m);
  const entries: Record<string, { compilerGenerates: boolean; assemblerChecked: number; emulatorChecked: number }> = {};
  for (const spec of b.instructions) entries[spec.mnemonic] = { compilerGenerates: false, assemblerChecked: 0, emulatorChecked: 0 };
  const count = (e: { compilerGenerates: boolean; assemblerChecked: number }, counts: Record<string, number>): void => {
    e.assemblerChecked += Object.values(counts).reduce((a, n) => a + n, 0);
    if ((counts['compiled'] ?? 0) > 0) e.compilerGenerates = true;
  };
  // A real instruction is counted by the mnemonic of the listing; a pseudoinstruction or alias by the name the
  // source used, so that an instruction written through an alias is not counted twice.
  for (const spec of b.instructions) {
    if (spec.pseudo && pseudo[spec.mnemonic]) count(entries[spec.mnemonic]!, pseudo[spec.mnemonic]!);
  }
  for (const [m, counts] of Object.entries(enc)) {
    const e = entries[key(m)];
    const spec = b.instructions.find((s) => s.mnemonic === key(m));
    if (!e || spec?.pseudo) continue;
    count(e, counts);
  }
  for (const [m, v] of Object.entries(exe)) {
    const e = entries[key(m)];
    if (e) e.emulatorChecked += v.passed;
  }
  matrix.targets[t] = entries;
}
outputs.push({ path: join(root, 'src', 'app', 'data', 'support-matrix.json'), text: JSON.stringify(matrix, null, 1) + '\n', dated: true });

const summary = {
  source: tree.sha256,
  crosscheck: crosscheck ? { runs: crosscheck.totals.runs, failed: crosscheck.failure_count, programs: crosscheck.corpus.programs } : null,
  semantics: semantics ? { ...semantics.totals, failed: semantics.failure_count } : null,
  targets: Object.fromEntries(targets.map((t) => [t, Object.fromEntries(stages.map((s) => [s, perTarget[t]![s] ? { failures: perTarget[t]![s].failure_count, totals: perTarget[t]![s].totals ?? perTarget[t]![s].summary } : null]))])),
};
outputs.push({ path: join(results, 'summary.json'), text: JSON.stringify(summary, null, 1) + '\n' });
const failures = [crosscheck?.failure_count ?? 0, semantics?.failure_count ?? 0, ...targets.flatMap((t) => stages.map((s) => perTarget[t]![s]?.failure_count ?? 0))].reduce((a, b) => a + b, 0);
const names = outputs.map((o) => relative(root, o.path).split('\\').join('/')).join(', ');
if (check) {
  const comparable = (text: string, dated: boolean): string => {
    const t = text.replace(/\r\n/g, '\n');
    return dated ? t.replace(/"generated": "[^"]*"/, '"generated": ""') : t;
  };
  const differing = outputs.filter((o) => !existsSync(o.path) || comparable(readFileSync(o.path, 'utf8'), o.dated === true) !== comparable(o.text, o.dated === true));
  for (const o of differing) console.log(`not the summary of the result files: ${relative(root, o.path).split('\\').join('/')}`);
  if (differing.length > 0) {
    console.log('run node scripts/summarize-validation.ts to regenerate the summary from the result files');
    process.exitCode = 1;
  } else console.log(`the summary files are generated from the result files: ${names}; total failures ${failures}`);
} else {
  for (const o of outputs) writeFileSync(o.path, o.text);
  console.log(`summary written: ${names}; total failures ${failures}`);
}
if (missing.length > 0) console.log(`the summary is partial: no result file for ${missing.join('; ')}`);
