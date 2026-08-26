export type PromptState = 'sending' | 'queued' | 'accepted' | 'expired' | 'failed';

export interface PromptDisplay {
  tone: 'neutral' | 'pending' | 'good' | 'warn' | 'error';
  message: string;
  showResend: boolean;
  keepText: boolean;
}

/** Maps a PromptStatus to how the composer/thread should present it (spec §7). */
export function promptDisplay(state: PromptState): PromptDisplay {
  switch (state) {
    case 'sending':  return { tone: 'pending', message: 'Sending…', showResend: false, keepText: true };
    case 'queued':   return { tone: 'pending', message: 'Waiting for the session to finish', showResend: false, keepText: false };
    case 'accepted': return { tone: 'good', message: '', showResend: false, keepText: false };
    case 'expired':  return { tone: 'warn', message: 'Never picked up', showResend: true, keepText: true };
    case 'failed':   return { tone: 'error', message: "Couldn't reach the session", showResend: true, keepText: true };
  }
}
