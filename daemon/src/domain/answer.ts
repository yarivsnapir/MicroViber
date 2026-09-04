import type { AnswerBody } from '../schemas/api.js';
import type { AskUserQuestionInput } from '../lib/claude-adapter/schemas.js';

export interface PendingQuestion { toolUseId: string; questions: AskUserQuestionInput[] }

/** Stable serialization used for replay matching and for auditing pre-composition rejections (spec §5.2). */
export function canonicalAnswerBody(a: AnswerBody): string {
  return JSON.stringify({ toolUseId: a.toolUseId, selections: a.selections });
}

/**
 * Spec §5.2 checks, in order. Pure — no I/O. Labels are model-authored
 * transcript content about to be echoed back into the session; exact
 * matching against the pending question's own options is what keeps this
 * from being an arbitrary-text write path (T11 note).
 */
export function validateAnswer(pending: PendingQuestion | null, a: AnswerBody): { ok: true } | { ok: false; message: string } {
  if (!pending || pending.toolUseId !== a.toolUseId) return { ok: false, message: 'question is no longer pending' };
  if (a.selections.length !== pending.questions.length) return { ok: false, message: 'answer must cover every question' };
  for (const [i, q] of pending.questions.entries()) {
    const picked = a.selections[i] ?? [];
    if (picked.length === 0) return { ok: false, message: 'answer must cover every question' };
    if (picked.length > 1 && q.multiSelect !== true) return { ok: false, message: `question ${q.header} accepts one option` };
    const allowed = new Set(q.options.map((o) => o.label));
    if (picked.some((label) => !allowed.has(label))) return { ok: false, message: `unknown option for ${q.header}` };
  }
  return { ok: true };
}
