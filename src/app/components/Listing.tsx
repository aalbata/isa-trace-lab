/**
 * Assembly listing with addresses, encoded bytes, pseudoinstruction notes, and
 * source lines. Rows can carry breakpoints; the bytes of a row can be edited
 * while the machine is paused, which invalidates the row's provenance.
 */
import { useEffect, useRef, useState } from 'react';
import type { ListingLine } from '../engine/protocol.ts';
import { REGION_LABEL, bytesText, hex32 } from './format.ts';

export interface ListingProps {
  lines: ListingLine[];
  /** Address of the instruction about to execute. */
  pc?: number | null;
  /** Addresses related to the item under the pointer. */
  related?: ReadonlySet<number>;
  stale?: ReadonlySet<number>;
  breakpoints?: ReadonlySet<number>;
  onToggleBreakpoint?: (address: number) => void;
  onHover?: (line: ListingLine | null) => void;
  /** Called with replacement bytes for the instruction at an address. */
  onEditBytes?: (address: number, bytes: number[]) => void;
  /** Hide runtime support code behind a summary row. */
  compact?: boolean;
  showSourceLines?: boolean;
  caption: string;
}

export function Listing(props: ListingProps) {
  const { lines, pc, related, stale, breakpoints } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ address: number; text: string; error: string } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  /** Address whose bytes button receives focus when Enter or Escape closes the byte editor. */
  const refocus = useRef<number | null>(null);
  useEffect(() => {
    if (editing !== null) return;
    const address = refocus.current;
    refocus.current = null;
    if (address !== null) container.current?.querySelector<HTMLButtonElement>(`tr[data-address="${address}"] .bytes-button`)?.focus();
  }, [editing]);
  const rows: React.ReactNode[] = [];
  let region = '';
  let hiddenCount = 0;
  let hiddenRegion = '';

  const flushHidden = (): void => {
    if (hiddenCount === 0) return;
    const name = hiddenRegion;
    rows.push(
      <tr key={`hidden-${name}-${rows.length}`} className="listing-hidden">
        <td colSpan={6}>
          <button type="button" className="link-button" onClick={() => setExpanded(new Set(expanded).add(name))}>
            Show {hiddenCount} instruction{hiddenCount === 1 ? '' : 's'} of the {REGION_LABEL[name]?.toLowerCase() ?? name}
          </button>
        </td>
      </tr>,
    );
    hiddenCount = 0;
  };

  const commit = (address: number, length: number): void => {
    if (!editing || !props.onEditBytes) return;
    const cleaned = editing.text.replace(/0x/gi, '').replace(/[\s,]/g, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(cleaned)) {
      setEditing({ ...editing, error: 'enter bytes as pairs of hexadecimal digits' });
      return;
    }
    const bytes = cleaned.match(/../g)!.map((h) => parseInt(h, 16));
    if (bytes.length !== length) {
      setEditing({ ...editing, error: `enter exactly ${length} byte${length === 1 ? '' : 's'}` });
      return;
    }
    props.onEditBytes(address, bytes);
    refocus.current = address;
    setEditing(null);
  };

  for (const line of lines) {
    if (line.region !== region) {
      flushHidden();
      region = line.region;
      rows.push(
        <tr key={`region-${line.address}`} className="listing-region">
          <th colSpan={6} scope="colgroup">{REGION_LABEL[region] ?? region}</th>
        </tr>,
      );
    }
    if (props.compact && region !== 'main' && !expanded.has(region) && line.address !== pc) {
      hiddenCount++;
      hiddenRegion = region;
      continue;
    }
    for (const label of line.labels) {
      rows.push(
        <tr key={`label-${label}-${line.address}`} className="listing-label">
          <td />
          <td colSpan={5}>{label}:</td>
        </tr>,
      );
    }
    const isPc = line.address === pc;
    const isStale = stale?.has(line.address) === true;
    const cls = ['listing-row', isPc ? 'is-current' : '', related?.has(line.address) ? 'is-related' : '', isStale ? 'is-stale' : ''].join(' ').trim();
    const hasBreak = breakpoints?.has(line.address) === true;
    rows.push(
      <tr
        key={line.address}
        className={cls}
        data-address={line.address}
        aria-current={isPc ? 'step' : undefined}
        onMouseEnter={() => props.onHover?.(line)}
        onMouseLeave={() => props.onHover?.(null)}
        onFocus={() => props.onHover?.(line)}
      >
        <td className="listing-break">
          {props.onToggleBreakpoint && (
            <button
              type="button"
              className={hasBreak ? 'break-button is-set' : 'break-button'}
              aria-pressed={hasBreak}
              aria-label={`${hasBreak ? 'Remove' : 'Set'} breakpoint at ${hex32(line.address)}`}
              onClick={() => props.onToggleBreakpoint!(line.address)}
            >
              ●
            </button>
          )}
        </td>
        <td className="mono listing-address">{hex32(line.address)}{isPc && <span className="visually-hidden"> (next instruction)</span>}</td>
        <td className="mono listing-bytes">
          {editing?.address === line.address ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commit(line.address, line.bytes.length);
              }}
            >
              <input
                className="byte-input"
                aria-label={`New bytes for the instruction at ${hex32(line.address)}`}
                value={editing.text}
                autoFocus
                onChange={(e) => setEditing({ address: line.address, text: e.target.value, error: '' })}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  refocus.current = line.address;
                  setEditing(null);
                }}
                onBlur={() => setEditing(null)}
              />
              {editing.error && <span className="field-error" role="alert">{editing.error}</span>}
            </form>
          ) : props.onEditBytes ? (
            <button
              type="button"
              className="bytes-button"
              title="Edit these bytes in memory"
              aria-label={`Bytes ${bytesText(line.bytes)}; edit`}
              onClick={() => setEditing({ address: line.address, text: bytesText(line.bytes), error: '' })}
            >
              {bytesText(line.bytes)}
            </button>
          ) : (
            bytesText(line.bytes)
          )}
        </td>
        <td className="mono listing-text">{line.text}</td>
        <td className="listing-note">
          {isStale ? <span className="stale-note">bytes edited: source mapping no longer applies</span> : (
            <>
              {line.pseudo && <span className="mono pseudo-note" title="Pseudoinstruction or alias that this instruction expands">{line.pseudo}</span>}
              {line.pseudo && line.note && <span className="visually-hidden">; </span>}
              {line.note && <span className="plain-note">{line.note}</span>}
            </>
          )}
        </td>
        {props.showSourceLines !== false && (
          <td className="listing-lines">{isStale ? '' : line.lines.length > 0 ? `line ${line.lines.join(', ')}` : line.asmLine !== undefined ? `line ${line.asmLine}` : ''}</td>
        )}
      </tr>,
    );
  }
  flushHidden();

  return (
    <div ref={container} className="table-scroll" tabIndex={0} role="region" aria-label={props.caption}>
      <table className="listing">
        <caption className="visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            <th scope="col"><span className="visually-hidden">Breakpoint</span></th>
            <th scope="col">Address</th>
            <th scope="col">Bytes in memory</th>
            <th scope="col">Instruction</th>
            <th scope="col">Shorthand and note</th>
            {props.showSourceLines !== false && <th scope="col">Source</th>}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
