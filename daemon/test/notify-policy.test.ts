import { describe, it, expect } from 'vitest';
import { NotifyPolicy } from '../src/domain/notify-policy.js';

type S = { id: string; state: 'working' | 'idle' | 'stale'; title: string; statusLine?: string };

describe('NotifyPolicy', () => {
  it('working -> idle emits a notify tagged session:<id> with the status line', () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'working', title: 'T' }]);
    const out = np.reconcile([{ id: 's1', state: 'idle', title: 'T', statusLine: 'tests passed' }] as S[]);
    expect(out).toEqual([{ type: 'notify', sessionId: 's1', tag: 'session:s1', title: 'T', body: 'tests passed' }]);
  });

  it('idle -> working emits a dismiss for that tag (A6: overtaken by events)', () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
    const out = np.reconcile([{ id: 's1', state: 'working', title: 'T' }] as S[]);
    expect(out).toEqual([{ type: 'dismiss', tag: 'session:s1' }]);
  });

  it('idle -> idle emits nothing (no re-notify, no stacking)', () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
    expect(np.reconcile([{ id: 's1', state: 'idle', title: 'T' }] as S[])).toEqual([]);
  });

  it('a session going away (stale/removed) while idle dismisses its notification', () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
    const out = np.reconcile([] as S[]);
    expect(out).toEqual([{ type: 'dismiss', tag: 'session:s1' }]);
  });

  it('opening a session dismisses its notification (clear-on-open)', () => {
    const np = new NotifyPolicy();
    np.reconcile([{ id: 's1', state: 'idle', title: 'T' }]);
    expect(np.onOpened('s1')).toEqual({ type: 'dismiss', tag: 'session:s1' });
  });
});
