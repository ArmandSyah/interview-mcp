import { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/types';
import type { ReleaseChannel, UpdateStatus } from '../shared/updates';

export function DistributionSettings({ beforeAction }: { beforeAction: () => Promise<void> }) {
  const [info, setInfo] = useState<{
    contentSigningConfigured: boolean;
    checkoutConfigured: boolean;
  } | null>(null);
  const [packs, setPacks] = useState<Snapshot['installedPacks']>([]);
  const [updates, setUpdates] = useState<UpdateStatus | null>(null);
  const [channel, setChannel] = useState<ReleaseChannel>('stable');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [notices, setNotices] = useState('');
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.interview.distributionInfo(),
      window.interview.updateInfo(),
      window.interview.snapshot(),
    ])
      .then(([info, update, snapshot]) => {
        if (live) {
          setInfo(info);
          setUpdates(update);
          setPacks(snapshot.installedPacks);
        }
      })
      .catch((error) => {
        if (live)
          setMessage(error instanceof Error ? error.message : 'Cannot load distribution settings');
      });
    return () => {
      live = false;
    };
  }, []);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await beforeAction();
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <fieldset>
        <legend>Original content packs</legend>
        <p className="form-note">
          Core practice stays free. Purchased versions remain usable offline forever; the license
          states the window for new releases. No subscription is required.
        </p>
        {packs.map((pack) => (
          <p className="form-note" key={pack.pack_id}>
            {pack.title} · {pack.version} · updates through{' '}
            {new Date(pack.updates_until).toLocaleDateString()}
          </p>
        ))}
        {!info?.contentSigningConfigured && (
          <p className="form-note">
            Paid packs are not configured in this preview. The included curriculum is development
            content, not a human-reviewed paid release.
          </p>
        )}
        <div className="distribution-actions">
          <button
            type="button"
            className="secondary small"
            disabled={busy || !info?.contentSigningConfigured}
            onClick={() =>
              void action(async () => {
                await window.interview.installContentPack();
                setPacks((await window.interview.snapshot()).installedPacks);
              })
            }
          >
            Install pack & license
          </button>
          {info?.checkoutConfigured && (
            <button
              type="button"
              className="secondary small"
              disabled={busy}
              onClick={() => void action(() => window.interview.openCheckout())}
            >
              Open hosted checkout
            </button>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Backups & signed releases</legend>
        <p className="form-note">
          Export code, conversations, canvas images, checkpoints, and practice records. API
          credentials are excluded. This file is a portable archive; there is no in-app restore UI
          yet.
        </p>
        <button
          type="button"
          className="secondary small"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const path = await window.interview.exportWorkspace();
              if (path) setMessage('Practice backup exported without saved API credentials.');
            })
          }
        >
          Export practice backup
        </button>
        <label>
          Release channel
          <select
            value={channel}
            disabled={busy}
            onChange={(event) => setChannel(event.target.value as ReleaseChannel)}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta — prerelease builds</option>
          </select>
        </label>
        <p className="form-note">{updates?.message ?? 'Loading release settings…'}</p>
        {updates?.notes && (
          <p className="form-note">
            {updates.version}: {updates.notes}
          </p>
        )}
        <div className="distribution-actions">
          <button
            type="button"
            className="secondary small"
            disabled={busy || !updates || updates.state === 'unconfigured'}
            onClick={() =>
              void action(async () => setUpdates(await window.interview.checkUpdates(channel)))
            }
          >
            Check for signed updates
          </button>
          {updates?.state === 'available' && (
            <button
              type="button"
              className="secondary small"
              disabled={busy}
              onClick={() =>
                void action(async () => setUpdates(await window.interview.downloadUpdate()))
              }
            >
              Download verified installer
            </button>
          )}
          {updates?.state === 'ready' && (
            <button
              type="button"
              className="secondary small"
              disabled={busy}
              onClick={() => void action(() => window.interview.openUpdateInstaller())}
            >
              Back up & open installer
            </button>
          )}
        </div>
        <p className="form-note">
          No background checks or automatic installs. App and engine travel together; signatures and
          checksums are verified before an installer can open.
        </p>
      </fieldset>
      <fieldset>
        <legend>Open-source notices</legend>
        <button
          type="button"
          className="secondary small"
          disabled={busy}
          onClick={() =>
            void action(async () => setNotices(await window.interview.licenseNotices()))
          }
        >
          View canvas & font notices
        </button>
        {notices && <pre className="license-notices">{notices}</pre>}
      </fieldset>
      {busy && (
        <p className="form-note" role="status">
          Working… downloads may take a few minutes.
        </p>
      )}
      {message && (
        <p className="form-note" role="status">
          {message}
        </p>
      )}
    </>
  );
}
