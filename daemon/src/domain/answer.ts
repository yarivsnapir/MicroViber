import type { AnswerBody } from '../schemas/api.js';

/** Stable serialization used for replay matching and for auditing pre-composition rejections (spec §5.2). */
export function canonicalAnswerBody(a: AnswerBody): string {
  return JSON.stringify({ toolUseId: a.toolUseId, selections: a.selections });
}
