import { VERSION } from '../core/api.ts';
import { About } from './pages/About.tsx';
import { Assembler } from './pages/Assembler.tsx';
import { Compare } from './pages/Compare.tsx';
import { Exercises } from './pages/Exercises.tsx';
import { Explorer } from './pages/Explorer.tsx';
import { Start } from './pages/Start.tsx';
import { Workspace } from './pages/Workspace.tsx';
import { href, useRoute } from './router.ts';
import type { Route } from './router.ts';
import { useAppState } from './store.ts';

const NAV: { page: Route['page']; label: string }[] = [
  { page: 'start', label: 'Start' },
  { page: 'explore', label: 'Instruction sets' },
  { page: 'workspace', label: 'Code workspace' },
  { page: 'compare', label: 'Compare architectures' },
  { page: 'assembler', label: 'Assembler and decoder' },
  { page: 'exercises', label: 'Exercises' },
  { page: 'about', label: 'About' },
];

export function App() {
  const route = useRoute();
  const app = useAppState();
  let page: React.ReactNode;
  switch (route.page) {
    case 'explore':
      page = <Explorer target={route.params[0]} mnemonic={route.params[1]} />;
      break;
    case 'workspace':
      page = <Workspace />;
      break;
    case 'compare':
      page = <Compare />;
      break;
    case 'assembler':
      page = <Assembler target={route.params[0]} />;
      break;
    case 'exercises':
      page = <Exercises />;
      break;
    case 'about':
      page = <About />;
      break;
    default:
      page = <Start />;
  }
  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          // Pages are addressed by the URL fragment, so the link moves focus without changing the fragment.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to the main content
      </a>
      <header className="app-header">
        <a className="brand" href={href('start')}>ISA Trace Lab <span className="version">{VERSION}</span></a>
        <nav aria-label="Sections">
          <ul>
            {NAV.map((n) => (
              <li key={n.page}>
                <a href={n.page === 'explore' ? href('explore', app.target) : href(n.page)} aria-current={route.page === n.page ? 'page' : undefined}>{n.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>{page}</main>
      <footer className="app-footer">
        ISA Trace Lab runs entirely in this browser. No account, no telemetry, and no program text leaves the device.
        The simulators are educational models of documented instruction-set subsets; instruction counts are not measurements of processor speed.
      </footer>
    </div>
  );
}
