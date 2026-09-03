import { TranscriptLineSchema, ToolUseBlock, ToolResultBlock, AskUserQuestionInputSchema, type AskUserQuestionInput } from './schemas.js';

/**
 * Claude Code writes this exact literal text as a synthetic "user" turn when
 * a request gets interrupted — never a real prompt. Nothing distinguishes it
 * structurally from a genuine user turn (same type/role), so it's matched by
 * content: without this, an interrupted turn can make this marker itself
 * become the session's fallback title.
 */
const INTERRUPTION_MARKER = '[Request interrupted by user]';

export interface TranscriptMeta {
  title: string | null;      // newest custom-title, else newest ai-title, else null
  lastPrompt: string | null; // newest last-prompt / user turn text, for title fallback
  lastPromptAt: string | null;   // timestamp of newest USER turn
  lastActivityAt: string | null; // timestamp of newest entry of any kind
  /**
   * True while the newest conversational entry says a turn is still in
   * flight: a user prompt or tool_result awaiting the model, or an assistant
   * entry that did NOT stop with 'end_turn' (a tool call in flight). False
   * once the assistant parks with stop_reason 'end_turn' or the user
   * interrupts — the "waiting for you" states.
   */
  turnOpen: boolean;
  /**
   * True while an async Agent dispatch has been launched (tool_result with
   * toolUseResult.isAsync) but no matching <task-notification> has come back
   * yet. That launch acknowledgement returns immediately, so the assistant
   * routinely parks with stop_reason 'end_turn' right after — turnOpen goes
   * false even though real work is still happening in the background. This
   * is the case turnOpen alone can't see: the session is not "waiting for
   * you", it's waiting on its own dispatched job.
   */
  hasOutstandingBackgroundTask: boolean;
  /**
   * Pending AskUserQuestion: a tool_use with id and questions, waiting for a
   * matching tool_result. Null if no pending question or if a result has
   * already been received.
   */
  pendingQuestion: { toolUseId: string; questions: AskUserQuestionInput[] } | null;
}

/**
 * Scan raw transcript .jsonl text for the metadata the session list needs.
 * Cheap forward pass; tolerant of malformed/partial lines (skips them).
 * "lastPromptAt" is the newest USER turn specifically — a session can churn
 * tools for an hour after its last prompt, and the list sorts by "who I last
 * talked to" (spec §3).
 */
export function scanTranscriptMeta(jsonl: string): TranscriptMeta {
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let lastPrompt: string | null = null;
  let lastPromptAt: string | null = null;
  let lastActivityAt: string | null = null;
  let turnOpen = false;
  let outstandingBackgroundTasks = 0;
  let pendingQuestion: TranscriptMeta['pendingQuestion'] = null;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // partial trailing line or noise
    }
    const parsed = TranscriptLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;

    if (e.type === 'ai-title') aiTitle = e.aiTitle;
    else if (e.type === 'custom-title') customTitle = e.customTitle;
    else if (e.type === 'last-prompt') lastPrompt = e.lastPrompt;

    const ts = 'timestamp' in e ? e.timestamp : undefined;
    if (ts) lastActivityAt = ts;
    if (e.type === 'user') {
      const text = extractText(e.message.content);
      // The interruption marker isn't a real prompt — excluded from both the
      // fallback title/subtitle text AND the sort-key timestamp, so a plain
      // interruption (no new prompt typed) can't bump a session to the top
      // of the "most recently prompted" list while showing an older subtitle.
      if (text && text !== INTERRUPTION_MARKER) {
        lastPrompt = text;
        if (ts) lastPromptAt = ts;
      }
      // An interruption closes the turn; any other user entry (real prompt
      // or tool_result) means the model owes a response.
      turnOpen = text !== INTERRUPTION_MARKER;
      if (e.toolUseResult?.isAsync) outstandingBackgroundTasks++;
      if (e.origin?.kind === 'task-notification') {
        outstandingBackgroundTasks = Math.max(0, outstandingBackgroundTasks - 1);
      }
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const parsed = ToolResultBlock.safeParse(block);
          if (parsed.success && pendingQuestion && parsed.data.tool_use_id === pendingQuestion.toolUseId) {
            pendingQuestion = null;
          }
        }
      }
    } else if (e.type === 'assistant') {
      turnOpen = e.message.stop_reason !== 'end_turn';
      const content = e.message.content;
      if (Array.isArray(content)) {
        // SYNC: tail.ts's extractAskUserQuestion implements the same
        // tool_use-loop + zod-validate + name-check detection independently
        // — deliberately not shared (different jobs: that one emits a
        // per-occurrence event with independent resolution; this one
        // maintains a single rolling "is anything pending" slot). Two known,
        // currently-latent divergences:
        //   1. Multiple simultaneously-pending questions: this keeps a
        //      single slot, last-write-wins (a second pending question's
        //      resolution clears the slot entirely, losing the first
        //      question's pendency); tail.ts tracks each toolUseId
        //      independently.
        //   2. Two AskUserQuestion blocks in one assistant message: this
        //      loop keeps the last one seen; tail.ts's extractAskUserQuestion
        //      returns on the first and drops the rest.
        // A future change to one's detection logic should check whether it
        // needs to apply to the other too.
        for (const block of content) {
          const parsedBlock = ToolUseBlock.safeParse(block);
          if (parsedBlock.success && parsedBlock.data.name === 'AskUserQuestion') {
            const parsedInput = AskUserQuestionInputSchema.safeParse(parsedBlock.data.input);
            if (parsedInput.success) {
              pendingQuestion = { toolUseId: parsedBlock.data.id, questions: parsedInput.data.questions };
            }
          }
        }
      }
    }
    // Metadata entries (titles, last-prompt) never change turn state.
  }
  // A manually-set title is a deliberate override — it wins over whatever
  // the auto-titler comes up with, same as the VS Code tab keeps showing it.
  return {
    title: customTitle ?? aiTitle,
    lastPrompt,
    lastPromptAt,
    lastActivityAt,
    turnOpen,
    hasOutstandingBackgroundTask: outstandingBackgroundTasks > 0,
    pendingQuestion,
  };
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text);
    if (parts.length) return parts.join(' ');
  }
  return null;
}
