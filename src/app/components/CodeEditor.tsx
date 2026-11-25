/**
 * Source editor built on CodeMirror 6. It shows diagnostics at their source
 * ranges and marks lines: the lines of the instruction about to execute, the
 * lines related to the item under the pointer, and breakpoints. Tab indents;
 * Escape and then Tab, or Ctrl+M, let Tab move focus out of the editor, and a
 * note below the editor, which is also its accessible description, says so.
 * Breakpoints are toggled from the margin, from the line numbers, or with F9
 * on the line with the cursor.
 */
import { python } from '@codemirror/lang-python';
import { setDiagnostics } from '@codemirror/lint';
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, keymap, lineNumbers } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { indentWithTab, toggleTabFocusMode } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { useEffect, useId, useRef } from 'react';
import type { Diagnostic } from '../../core/api.ts';

interface Marks {
  current: number[];
  related: number[];
  breakpoints: number[];
}

const setMarks = StateEffect.define<Marks>();

const marksField = StateField.define<{ marks: Marks; deco: DecorationSet }>({
  create: () => ({ marks: { current: [], related: [], breakpoints: [] }, deco: Decoration.none }),
  update(value, tr) {
    let marks = value.marks;
    for (const e of tr.effects) if (e.is(setMarks)) marks = e.value;
    if (marks === value.marks && !tr.docChanged) return value;
    const ranges: Range<Decoration>[] = [];
    const doc = tr.state.doc;
    const add = (lines: number[], cls: string): void => {
      for (const n of lines) {
        if (n >= 1 && n <= doc.lines) ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from));
      }
    };
    add(marks.related, 'cm-related-line');
    add(marks.current, 'cm-current-line');
    ranges.sort((a, b) => a.from - b.from);
    return { marks, deco: Decoration.set(ranges, true) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

class BreakpointMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-breakpoint-dot';
    el.textContent = '●';
    el.title = 'Breakpoint';
    return el;
  }
}
const breakpointMarker = new BreakpointMarker();

/**
 * Keys that let Tab and Shift+Tab move focus out of the editor although they
 * indent. CodeMirror lets Tab move focus within two seconds after an Escape
 * that no command handled; here every Escape in the editor opens that
 * interval, also one that closes the completion list, the search panel or a
 * dialog, or that reduces the selection. Ctrl+M switches Tab between indenting
 * and moving focus. CodeMirror binds that command to Shift+Alt+M on macOS,
 * where the combination types a character instead (Â with the US layout), so
 * Ctrl+M is bound on macOS as well.
 */
const tabFocusKeys = [
  ViewPlugin.define((v) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) v.setTabFocusMode(2000);
    };
    // Listening on the editor root in the capture phase sees the key before a command or a panel handles it.
    v.dom.addEventListener('keydown', onKeyDown, true);
    return { destroy: () => v.dom.removeEventListener('keydown', onKeyDown, true) };
  }),
  keymap.of([{ mac: 'Ctrl-m', run: toggleTabFocusMode }]),
];

const EDITOR_KEYS = 'In the editor, Tab and Shift+Tab change the indentation. To move focus out of the editor with the keyboard, press Escape and then, within two seconds, Tab or Shift+Tab. Ctrl+M switches Tab and Shift+Tab between changing the indentation and moving focus.';
const BREAKPOINT_KEYS = 'F9 sets or removes a breakpoint on the line with the cursor.';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: 'python' | 'plain';
  readOnly?: boolean;
  diagnostics?: Diagnostic[];
  /** Lines of the instruction about to execute. */
  currentLines?: number[];
  /** Lines related to the item under the pointer or cursor. */
  relatedLines?: number[];
  breakpoints?: number[];
  onToggleBreakpoint?: (line: number) => void;
  /** Reports the line of the cursor. */
  onCursorLine?: (line: number) => void;
  ariaLabel: string;
  minHeight?: string;
}

export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const readOnly = useRef(new Compartment());
  const description = useRef(new Compartment());
  const keysId = useId();
  const keys = [props.readOnly ? '' : EDITOR_KEYS, props.onToggleBreakpoint ? BREAKPOINT_KEYS : ''].filter((s) => s !== '').join(' ');
  const noted = keys !== '';
  // The note below the editor, when there is one, is the accessible description of the editable element.
  const describedBy = (shown: boolean) => EditorView.contentAttributes.of(shown ? { 'aria-describedby': keysId } : {});

  useEffect(() => {
    if (!host.current) return undefined;
    const toggleBreakpoint = (v: EditorView, pos: number): boolean => {
      latest.current.onToggleBreakpoint?.(v.state.doc.lineAt(pos).number);
      return true;
    };
    const breakpointGutter = gutter({
      class: 'cm-breakpoint-gutter',
      lineMarker(v, line) {
        const n = v.state.doc.lineAt(line.from).number;
        return v.state.field(marksField).marks.breakpoints.includes(n) ? breakpointMarker : null;
      },
      lineMarkerChange: (update) => update.transactions.some((t) => t.effects.some((e) => e.is(setMarks))),
      initialSpacer: () => breakpointMarker,
      domEventHandlers: {
        mousedown: (v, line) => toggleBreakpoint(v, line.from),
      },
    });
    const breakpoints = [
      breakpointGutter,
      // The handler is added to the line-number gutter of basicSetup; no second gutter is created.
      lineNumbers({ domEventHandlers: { mousedown: (v, line) => toggleBreakpoint(v, line.from) } }),
      keymap.of([{ key: 'F9', run: (v) => toggleBreakpoint(v, v.state.selection.main.head) }]),
    ];
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        ...(props.onToggleBreakpoint ? breakpoints : []),
        basicSetup,
        keymap.of([indentWithTab]),
        tabFocusKeys,
        ...(props.language === 'plain' ? [] : [python()]),
        marksField,
        readOnly.current.of(EditorState.readOnly.of(props.readOnly === true)),
        EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, tabindex: '0' }),
        description.current.of(describedBy(noted)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) latest.current.onCursorLine?.(u.state.doc.lineAt(u.state.selection.main.head).number);
        }),
        EditorView.theme({ '&': { minHeight: props.minHeight ?? '12rem' } }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later property changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(props.readOnly === true)) });
  }, [props.readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: description.current.reconfigure(describedBy(noted)) });
    // describedBy depends only on the identifier of the note, which does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noted]);

  const current = (props.currentLines ?? []).join(',');
  const related = (props.relatedLines ?? []).join(',');
  const breaks = (props.breakpoints ?? []).join(',');
  useEffect(() => {
    view.current?.dispatch({
      effects: setMarks.of({ current: props.currentLines ?? [], related: props.relatedLines ?? [], breakpoints: props.breakpoints ?? [] }),
    });
    // The joined strings stand for the array contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, related, breaks]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const out: CmDiagnostic[] = [];
    for (const d of props.diagnostics ?? []) {
      if (!d.span) continue;
      const from = Math.min(d.span.start.offset, doc.length);
      const to = Math.max(from, Math.min(d.span.end.offset, doc.length));
      out.push({ from, to: to === from ? Math.min(from + 1, doc.length) : to, severity: d.severity, message: d.hint ? `${d.message} (${d.hint})` : d.message });
    }
    v.dispatch(setDiagnostics(v.state, out));
  }, [props.diagnostics, props.value]);

  return (
    <>
      <div ref={host} className="code-editor" />
      {noted && <p id={keysId} className="hint editor-keys">{keys}</p>}
    </>
  );
}
