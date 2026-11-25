import { expect, test } from '@playwright/test';
import { withProgram } from './helpers.ts';

// x86-64 has six registers for variables, so the seventh variable, f, is kept in a stack slot there; the other targets keep it in a register.
const SEVEN = 'def main(n):\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    return a + b + c + d + e + f + n\n';

test.describe('variables kept in stack slots', () => {
  test('the comparison agrees while a variable kept in a stack slot is unassigned and after main returns', async ({ page }) => {
    await withProgram(page, { source: SEVEN, args: [0] });
    await page.goto('./#/compare');
    const verdict = page.locator('h2:has-text("Outcome") + div');
    await expect(verdict).toHaveText(
      'All targets ended the same way with the same output and return value. They agree on the statement reached and on every source variable at all 7 boundaries.',
    );
    await expect(verdict).toHaveClass('ok-box');
    const agrees = page.getByRole('region', { name: 'Sequence of statement boundaries' }).locator('tbody tr td:last-child');
    await expect(agrees).toHaveText(['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes']);
    const row = page.getByRole('region', { name: 'Source variables per target' }).locator('tr', { has: page.locator('th', { hasText: /^f$/ }) });
    await page.getByRole('button', { name: 'Step one statement on every target' }).click();
    await expect(page.locator('.sync-status')).toContainText('Every target is at statement boundary 1, about to execute source line 2.');
    await expect(row.locator('td')).toHaveText(['not assigned', 'not assigned', 'not assigned', 'not assigned', 'yes']);
    await page.getByRole('button', { name: 'Run every target to the end' }).click();
    await expect(page.locator('.sync-status')).toContainText('Every target has stopped.');
    await expect(row.locator('td')).toHaveText(['6', '6', '6', '6', 'yes']);
  });

  test('the workspace shows a variable kept in a stack slot as not assigned until it is stored', async ({ page }) => {
    await withProgram(page, { target: 'x86', source: SEVEN, args: [0] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for x86-64.')).toBeVisible();
    const machine = page.locator('section[aria-labelledby="machine-heading"]');
    const variables = machine.locator('details', { has: page.locator('summary', { hasText: 'Source variables' }) });
    const row = variables.locator('tr', { has: page.locator('th', { hasText: /^f$/ }) });
    await expect(row.locator('td')).toHaveText(['stack + 0', 'not assigned yet']);
    await machine.getByRole('button', { name: 'Step statement' }).click();
    await expect(machine.locator('.status').first()).toContainText('paused at');
    await expect(row.locator('td')).toHaveText(['stack + 0', 'not assigned yet']);
    await machine.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(machine.locator('.status').first()).toContainText('main returned 21');
    await expect(row.locator('td')).toHaveText(['stack + 0', '6']);
  });

  test('the workspace follows an edit of the stack pointer inside main for a variable kept in a stack slot', async ({ page }) => {
    const source = 'def main(n):\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    print(f)\n    f = f + 10\n    print(f)\n    return a + b + c + d + e + f + n\n';
    await withProgram(page, { target: 'x86', source, args: [0] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for x86-64.')).toBeVisible();
    const machine = page.locator('section[aria-labelledby="machine-heading"]');
    const status = machine.locator('.status').first();
    const step = machine.getByRole('button', { name: 'Step statement' });
    const row = machine.locator('details', { has: page.locator('summary', { hasText: 'Source variables' }) }).locator('tr', { has: page.locator('th', { hasText: /^f$/ }) });
    const printed = machine.locator('.output-list li');
    await step.click();
    await expect(status).toContainText('paused at 0x00400014 after 3 instructions');
    await step.click();
    await expect(status).toContainText('paused at 0x00400019 after 4 instructions');
    // Main's frame moves down 64 bytes before f is assigned; the program then stores and loads f there.
    await machine.getByRole('button', { name: 'rsp: 0x000000007fffeff0; edit' }).click();
    const input = machine.getByLabel('New value for rsp');
    await input.fill('0x7fffefb0');
    await input.press('Enter');
    await expect(machine.getByRole('button', { name: 'rsp: 0x000000007fffefb0; edit' })).toBeVisible();
    await expect(row.locator('td')).toHaveText(['stack + 0', 'not assigned yet']);
    for (const text of ['0x0040001f after 5', '0x00400025 after 6', '0x0040002b after 7', '0x00400031 after 8', '0x00400039 after 10']) {
      await step.click();
      await expect(status).toContainText(`paused at ${text} instructions`);
    }
    await expect(row.locator('td')).toHaveText(['stack + 0', '6']);
    await step.click();
    await expect(status).toContainText('paused at 0x00400045 after 14 instructions');
    await expect(printed).toHaveText(['6']);
    await step.click();
    await expect(status).toContainText('paused at 0x0040004e after 17 instructions');
    await expect(row.locator('td')).toHaveText(['stack + 0', '16']);
    await step.click();
    await expect(status).toContainText('paused at 0x0040005a after 21 instructions');
    await expect(printed).toHaveText(['6', '16']);
    await expect(row.locator('td')).toHaveText(['stack + 0', '16']);
  });

  test('the workspace shows a variable kept in a stack slot whose frame an edit has moved into the data region', async ({ page }) => {
    const source = 'def main(n):\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    print(f)\n    f = f + 10\n    print(f)\n    return a + b + c + d + e + f + n\n';
    await withProgram(page, { target: 'x86', source, args: [0] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for x86-64.')).toBeVisible();
    const machine = page.locator('section[aria-labelledby="machine-heading"]');
    const status = machine.locator('.status').first();
    const step = machine.getByRole('button', { name: 'Step statement' });
    const row = machine.locator('details', { has: page.locator('summary', { hasText: 'Source variables' }) }).locator('tr', { has: page.locator('th', { hasText: /^f$/ }) });
    const printed = machine.locator('.output-list li');
    await step.click();
    await expect(status).toContainText('paused at 0x00400014 after 3 instructions');
    // Main's frame moves to an unused part of the data region before f is assigned; the program then stores and loads f there.
    await machine.getByRole('button', { name: 'rsp: 0x000000007fffeff0; edit' }).click();
    const input = machine.getByLabel('New value for rsp');
    await input.fill('0x10008000');
    await input.press('Enter');
    await expect(machine.getByRole('button', { name: 'rsp: 0x0000000010008000; edit' })).toBeVisible();
    await expect(row.locator('td')).toHaveText(['stack + 0', 'not assigned yet']);
    for (const text of ['0x00400019 after 4', '0x0040001f after 5', '0x00400025 after 6', '0x0040002b after 7', '0x00400031 after 8']) {
      await step.click();
      await expect(status).toContainText(`paused at ${text} instructions`);
      await expect(row.locator('td')).toHaveText(['stack + 0', 'not assigned yet']);
    }
    await step.click();
    await expect(status).toContainText('paused at 0x00400039 after 10 instructions');
    await expect(row.locator('td')).toHaveText(['stack + 0', '6']);
    await step.click();
    await expect(status).toContainText('paused at 0x00400045 after 14 instructions');
    await expect(printed).toHaveText(['6']);
    await expect(row.locator('td')).toHaveText(['stack + 0', '6']);
    await step.click();
    await expect(status).toContainText('paused at 0x0040004e after 17 instructions');
    await expect(row.locator('td')).toHaveText(['stack + 0', '16']);
    await step.click();
    await expect(status).toContainText('paused at 0x0040005a after 21 instructions');
    await expect(printed).toHaveText(['6', '16']);
    await expect(row.locator('td')).toHaveText(['stack + 0', '16']);
  });
});
