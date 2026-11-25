/**
 * Field diagrams of an encoded instruction. Fixed-width instructions are
 * shown as a 32-bit word divided into bit fields, most significant bit on the
 * left; the byte order in memory is shown separately. Variable-length
 * instructions are shown as a sequence of byte components. Field values can be
 * edited, which produces new bytes that are decoded again by the real decoder.
 */
import { useEffect, useRef, useState } from 'react';
import type { BitField, ByteField } from '../../core/api.ts';
import { bytesText } from './format.ts';

function FieldEditor(props: { field: BitField; onChange?: (value: number) => void }) {
  const { field } = props;
  const width = field.hi - field.lo + 1;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  /** Set when Enter or Escape closes the editor, so that focus returns to the edit button. */
  const refocus = useRef(false);
  useEffect(() => {
    if (text === null && refocus.current) button.current?.focus();
    refocus.current = false;
  }, [text]);
  const binary = field.value.toString(2).padStart(width, '0');
  if (text === null || !props.onChange) {
    return props.onChange ? (
      <button ref={button} type="button" className="field-bits mono" aria-label={`${field.name}: binary ${binary}; edit`} onClick={() => setText(binary)}>{binary}</button>
    ) : (
      <span className="field-bits mono">{binary}</span>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        const v = /^[01]+$/.test(t) && t.length <= width ? parseInt(t, 2) : /^\d+$/.test(t) && t.length < 10 && Number(t) < 2 ** width && !/^[01]+$/.test(t) ? Number(t) : NaN;
        if (Number.isNaN(v)) {
          setError(true);
          return;
        }
        props.onChange!(v);
        refocus.current = true;
        setText(null);
        setError(false);
      }}
    >
      <input
        className={error ? 'field-input is-invalid' : 'field-input'}
        aria-label={`New binary value for ${field.name} (${width} bits)`}
        aria-invalid={error}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          refocus.current = true;
          setText(null);
        }}
      />
    </form>
  );
}

export function WordDiagram(props: { bytes: number[]; fields: BitField[]; onEdit?: (bytes: number[]) => void }) {
  const { bytes, fields } = props;
  const word = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
  const edit = (f: BitField, value: number): void => {
    const width = f.hi - f.lo + 1;
    const mask = width === 32 ? 0xffffffff : ((2 ** width - 1) * 2 ** f.lo) >>> 0;
    const next = ((word & ~mask) | ((value * 2 ** f.lo) & mask)) >>> 0;
    props.onEdit?.([next & 0xff, (next >>> 8) & 0xff, (next >>> 16) & 0xff, (next >>> 24) & 0xff]);
  };
  return (
    <div className="word-diagram">
      <div className="byte-order">
        <div>
          <span className="order-label">Instruction word (bit 31 on the left)</span>
          <span className="mono">0x{word.toString(16).padStart(8, '0')}</span>
        </div>
        <div>
          <span className="order-label">Bytes in memory (lowest address first, little-endian)</span>
          <span className="mono">{bytesText(bytes)}</span>
        </div>
      </div>
      <div className="field-row" role="list" aria-label="Bit fields of the instruction word, most significant first">
        {fields.map((f) => (
          <div key={`${f.hi}-${f.lo}`} role="listitem" className="field" style={{ flexGrow: f.hi - f.lo + 1 }}>
            <div className="field-range">{f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}</div>
            <FieldEditor field={f} onChange={props.onEdit ? (v) => edit(f, v) : undefined} />
            <div className="field-name">{f.name}</div>
            <div className="field-text">{f.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ByteDiagram(props: { bytes: number[]; fields: ByteField[]; onEdit?: (bytes: number[]) => void }) {
  const { bytes, fields } = props;
  const editBit = (b: ByteField, f: BitField, value: number): void => {
    const width = f.hi - f.lo + 1;
    const mask = ((1 << width) - 1) << f.lo;
    const next = bytes.slice();
    next[b.offset] = (next[b.offset]! & ~mask) | ((value << f.lo) & mask);
    props.onEdit?.(next);
  };
  return (
    <div className="byte-diagram">
      <div className="byte-order">
        <div>
          <span className="order-label">Bytes in memory, in the order the processor reads them ({bytes.length} byte{bytes.length === 1 ? '' : 's'})</span>
          <span className="mono">{bytesText(bytes)}</span>
        </div>
      </div>
      <div className="field-row" role="list" aria-label="Components of the instruction, in byte order">
        {fields.map((b) => (
          <div key={`${b.offset}-${b.name}`} role="listitem" className="field" style={{ flexGrow: Math.max(1, b.length) }}>
            <div className="field-range">byte {b.offset}{b.length > 1 ? ` to ${b.offset + b.length - 1}` : ''}</div>
            <div className="field-bits mono">{bytesText(bytes.slice(b.offset, b.offset + b.length))}</div>
            <div className="field-name">{b.name}</div>
            <div className="field-text">{b.text}</div>
            {b.bits && (
              <div className="sub-fields" role="list" aria-label={`Bit fields of the ${b.name} byte`}>
                {b.bits.map((f) => (
                  <div key={`${f.hi}-${f.lo}`} role="listitem" className="sub-field">
                    <span className="field-range">{f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}</span>
                    <FieldEditor field={f} onChange={props.onEdit ? (v) => editBit(b, f, v) : undefined} />
                    <span className="field-name">{f.name}</span>
                    <span className="field-text">{f.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
