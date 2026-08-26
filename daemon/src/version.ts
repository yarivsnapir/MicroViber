/** Daemon build identity. Kept trivial; expanded by the health route (Task 12). */
export const DAEMON_NAME = 'microviber-daemon';
export const DAEMON_VERSION = '0.0.0';

export function identity(): { name: string; version: string } {
  return { name: DAEMON_NAME, version: DAEMON_VERSION };
}
