import { randomUUID } from 'node:crypto';

/** X-Request-Id: reuse an incoming id, else mint one (§16.2). Present in every log + response. */
export function resolveRequestId(incoming: string | undefined): string {
  return incoming && incoming.trim() ? incoming.trim() : randomUUID();
}
