import { isHostAllowed } from '../middleware/host-allowlist.js';
import { isOriginAllowed } from '../middleware/cors.js';
import { checkBearer } from '../middleware/auth.js';

/**
 * T5: CORS does not govern WebSocket upgrades, so the upgrade must validate
 * Host, Origin AND bearer itself — or the socket is a hole next to a locked
 * door. Same three checks the HTTP hooks apply, enforced on the handshake.
 */
export function authorizeUpgrade(
  req: { host: string | undefined; origin: string | undefined; authHeader: string | undefined },
  cfg: { hosts: readonly string[]; origins: readonly string[]; token: string },
): { ok: true } | { ok: false; code: 'FORBIDDEN' | 'UNAUTHENTICATED' } {
  if (!isHostAllowed(req.host, cfg.hosts)) return { ok: false, code: 'FORBIDDEN' };
  if (!isOriginAllowed(req.origin, cfg.origins)) return { ok: false, code: 'FORBIDDEN' };
  if (!checkBearer(req.authHeader, cfg.token)) return { ok: false, code: 'UNAUTHENTICATED' };
  return { ok: true };
}
