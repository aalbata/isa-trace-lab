/** About: scope, versions, references, privacy, and network use. */
import pkg from '../../../package.json';
import { OPTIMIZATION_POLICY, SCHEMA_VERSION, VERSION, availableBackends } from '../../core/api.ts';
import { clearSavedState } from '../store.ts';

export function About() {
  const deps = pkg.dependencies as Record<string, string>;
  return (
    <div className="page about-page">
      <h1>About ISA Trace Lab</h1>
      <p className="lead">
        ISA Trace Lab is open-source research software for following one program through its translation and execution on documented subsets of four instruction
        sets. Version {VERSION}; document schema version {SCHEMA_VERSION}; optimization policy: {OPTIMIZATION_POLICY}.
      </p>

      <h2>Scope</h2>
      <ul className="plain-list">
        <li>The source language uses Python syntax with 32-bit integers. Its rules, including where it differs from Python, are in the language specification in the repository (docs/language.md).</li>
        <li>Path A shows genuine CPython bytecode from the CPython {deps['pyodide'] ? 'interpreter in the Pyodide ' + deps['pyodide'] + ' runtime' : 'interpreter'}. It is for inspection; the program is not executed there.</li>
        <li>Path B compiles the restricted language to real machine code for the profiles listed below and executes the encoded bytes on simulators written for this project.</li>
        <li>The profiles are subsets. They do not claim conformance to the architectures, compatibility with operating systems, or the timing of any processor.</li>
      </ul>

      <h2>Instruction-set profiles and reference documents</h2>
      <ul className="plain-list">
        {availableBackends().map((b) => (
          <li key={b.profile.id}>
            <strong>{b.profile.name}</strong>: {b.profile.isa}.
            {b.profile.references.length > 0 && <> Defined by {b.profile.references.map((r) => `${r.title} (${r.version})`).join('; ')}.</>}
          </li>
        ))}
      </ul>

      <h2>Validation</h2>
      <p>
        Encodings are compared with the Clang integrated assembler and the LLD linker, decodings with the Capstone disassembler, and execution with the Unicorn
        emulator, on instruction sweeps, random encodings, and a corpus of compiled programs. The results, the reference-tool versions, and the commands that
        reproduce them are in the repository (validation/ and docs/validation.md).
      </p>

      <h2>Privacy and network use</h2>
      <ul className="plain-list">
        <li>Everything runs in this browser. There are no accounts, no analytics, and no server-side processing; program text is not uploaded.</li>
        <li>The application files are downloaded once from the site that serves them. The CPython runtime (about 13 MB) is downloaded only when the bytecode view is opened, from the same site.</li>
        <li>The selected instruction set, the current program, its arguments, the level of detail, the exercises already answered, and exercise counts are kept in this browser's local storage so that a visit can be resumed.</li>
      </ul>
      <button type="button" onClick={() => {
        clearSavedState();
        window.location.reload();
      }}>Clear the data saved in this browser</button>

      <h2>Licences</h2>
      <p>
        ISA Trace Lab is released under the MIT licence. The bundled Pyodide runtime is distributed under the Mozilla Public License 2.0. It includes CPython under the
        Python Software Foundation License and further third-party libraries, among them libffi, libmpdec, expat, zstd, zlib, musl and the LLVM runtime libraries,
        each under its own licence. CodeMirror and React are distributed under the MIT licence. The full notices are in the repository and in the{' '}
        <a href="THIRD_PARTY_NOTICES.txt">third-party notice file</a> shipped with the site.
      </p>
      <h2>Versions of the main components</h2>
      <table className="plain-table">
        <caption className="visually-hidden">Versions of runtime dependencies</caption>
        <tbody>
          {Object.entries(deps).map(([name, version]) => <tr key={name}><th scope="row" className="mono">{name}</th><td className="mono">{version}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
