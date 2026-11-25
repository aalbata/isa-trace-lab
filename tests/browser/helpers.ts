import type { Page } from '@playwright/test';

export const STATE_KEY = 'isa-trace-lab/state/1';

/** Start the page with a given program and target in local storage. */
export async function withProgram(page: Page, state: { target?: string; source: string; args?: number[] }): Promise<void> {
  await page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [STATE_KEY, JSON.stringify({ target: state.target ?? 'riscv', source: state.source, exampleId: '', args: state.args ?? [], beginner: false, progress: {} })] as const);
}

export const SUMMATION = '# Sum of the integers from 1 to n with a for loop.\ndef main(n):\n    total = 0\n    for i in range(1, n + 1):\n        total += i\n    print(total)\n    return total\n';

export const ENDLESS = 'def main():\n    n = 0\n    while True:\n        n += 1\n';
