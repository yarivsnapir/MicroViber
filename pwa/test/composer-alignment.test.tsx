// @vitest-environment jsdom
// pwa/test/composer-alignment.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Composer } from '../src/components/Composer.js';

afterEach(cleanup);

describe('Composer action-row alignment (spec §4)', () => {
  it('right-aligns actions with Send as the rightmost element, Hand back to its left', () => {
    render(<Composer mode="owned" status={null} onSend={() => {}} onHandback={() => {}} />);
    const sendBtn = screen.getByRole('button', { name: '↑' });
    const handbackBtn = screen.getByRole('button', { name: /hand back/i });
    const actionsRow = sendBtn.parentElement!;

    expect(actionsRow).toBe(handbackBtn.parentElement);
    expect(actionsRow.className).toMatch(/justify-end/);
    const children = Array.from(actionsRow.children);
    expect(children.indexOf(sendBtn)).toBeGreaterThan(children.indexOf(handbackBtn));
  });

  it('failed state: status message stays left-aligned, Resend is rightmost in the same row', () => {
    render(<Composer mode="owned" status="failed" onSend={() => {}} onHandback={() => {}} />);
    const resendBtn = screen.getByRole('button', { name: /resend/i });
    const messageRow = resendBtn.parentElement!;

    expect(messageRow.textContent).toMatch(/Couldn't reach the session/);
    expect(messageRow.lastElementChild).toBe(resendBtn);
  });
});
