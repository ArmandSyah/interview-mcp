import { useEffect, useRef, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { Settings as SettingsType, SettingsUpdate } from '../shared/types';
import { DistributionSettings } from './DistributionSettings';
import { SandboxSettings } from './SandboxSettings';
import { MANAGED_PISTON_URL } from '../shared/sandbox';
import { useActions } from './actions';
import { Modal } from './Modal';

export function SettingsDialog({
  settings,
  onClose,
  onSave,
  beforeAction,
}: {
  settings: SettingsType;
  onClose: () => void;
  onSave: (settings: SettingsUpdate) => Promise<void>;
  beforeAction: () => Promise<void>;
}) {
  const actions = useActions();
  const [values, setValues] = useState<SettingsUpdate>({
    provider: settings.provider,
    model: settings.model,
    ollamaUrl: settings.ollamaUrl,
    corpusPath: settings.corpusPath,
    pistonUrl: settings.pistonUrl,
    managedSandbox: settings.managedSandbox,
    connection: settings.connection,
    mcpUrl: settings.mcpUrl,
  });
  const [error, setError] = useState('');
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);
  const [saving, setSaving] = useState(false);
  const busy = saving || actions.busy;
  const field = (key: keyof SettingsUpdate, value: unknown) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await actions.run(async () => {
        setSaving(true);
        setError('');
        try {
          await onSave(values);
          onClose();
        } finally {
          setSaving(false);
        }
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save settings');
    }
  }
  return (
    <Modal
      className="settings-modal"
      aria-labelledby="settings-title"
      onDismiss={onClose}
      canDismiss={!busy}
      dismissOnBackdrop
    >
      <header>
        <div>
          <span className="eyebrow">YOUR WORKSPACE, YOUR MODELS</span>
          <h2 id="settings-title">Workbench settings</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close settings"
          onClick={onClose}
          disabled={busy}
        >
          <X size={19} />
        </button>
      </header>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>AI coach</legend>
          <label>
            Provider
            <select
              value={values.provider}
              onChange={(event) => {
                const provider = event.target.value as SettingsUpdate['provider'];
                field('provider', provider);
                field('model', provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'qwen3:4b');
              }}
            >
              <option value="disabled">Off — practice with curated hints</option>
              <option value="ollama">Ollama — local model, no API fees</option>
              <option value="anthropic">Claude — bring your own API key</option>
            </select>
          </label>
          {values.provider !== 'disabled' && (
            <label>
              Model
              <input
                value={values.model}
                onChange={(event) => field('model', event.target.value)}
                required
                maxLength={120}
              />
            </label>
          )}
          {values.provider === 'ollama' && (
            <>
              <label>
                Ollama URL
                <input
                  value={values.ollamaUrl}
                  onChange={(event) => field('ollamaUrl', event.target.value)}
                  required
                />
              </label>
              <p className="form-note">
                Ollama must already be running on your computer with a tool-capable model installed.
                No model is downloaded automatically.
              </p>
            </>
          )}
          {values.provider === 'anthropic' && (
            <>
              <label>
                Claude API key
                <input
                  type="password"
                  autoComplete="off"
                  value={values.apiKey ?? ''}
                  placeholder={
                    settings.hasApiKey
                      ? 'Key saved — leave blank to keep it'
                      : 'Paste your own API key'
                  }
                  onChange={(event) => field('apiKey', event.target.value)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.clearApiKey ?? false}
                  onChange={(event) => field('clearApiKey', event.target.checked)}
                />
                Remove saved API key
              </label>
              <p className="form-note warning">
                Each chat turn sends your selected draft and problem context to Anthropic and incurs
                usage charges. Requests only happen when you send a message. The coach uses a
                bounded tool loop.
              </p>
            </>
          )}
          {!settings.secureStorage && (
            <p className="form-note warning">
              An OS credential store is unavailable. Keys stay in memory for this session and will
              not be written to disk.
            </p>
          )}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Interview MCP</legend>
          <label>
            Connection
            <select
              value={values.connection}
              onChange={(event) => field('connection', event.target.value)}
            >
              <option value="local">Local engine — no hosting bill</option>
              <option value="remote">Existing remote MCP</option>
            </select>
          </label>
          {values.connection === 'local' ? (
            <>
              <label>
                Private runtime question folder
                <div className="input-action">
                  <input
                    value={values.corpusPath}
                    placeholder="Bundled public examples"
                    onChange={(event) => field('corpusPath', event.target.value)}
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={async () => {
                      try {
                        await actions.run(async () => {
                          setError('');
                          await beforeAction();
                          const path = await window.interview.chooseCorpus();
                          if (path) field('corpusPath', path);
                        });
                      } catch (error) {
                        setError(
                          error instanceof Error
                            ? error.message
                            : 'Cannot open the directory picker',
                        );
                      }
                    }}
                  >
                    <FolderOpen size={16} /> Browse
                  </button>
                </div>
              </label>
              <p className="form-note">
                Choose an exported runtime folder, not the authoring repo. Your private questions
                never enter the app distribution.
              </p>
            </>
          ) : (
            <>
              <label>
                HTTPS MCP URL
                <input
                  value={values.mcpUrl}
                  placeholder="https://your-server/mcp"
                  onChange={(event) => field('mcpUrl', event.target.value)}
                  required
                />
              </label>
              <label>
                MCP bearer key or account token
                <input
                  type="password"
                  autoComplete="off"
                  value={values.mcpKey ?? ''}
                  placeholder={
                    settings.hasMcpKey
                      ? 'Credential saved — leave blank to keep it'
                      : 'Bearer credential'
                  }
                  onChange={(event) => field('mcpKey', event.target.value)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.clearMcpKey ?? false}
                  onChange={(event) => field('clearMcpKey', event.target.checked)}
                />
                Remove saved MCP key
              </label>
              <p className="form-note">
                Supabase accounts keep the same workspace when you replace an expired token. Other
                servers use a different workspace for each bearer key. Account sign-in is not
                available in this preview.
              </p>
              <p className="form-note warning">
                The remote service receives hint requests, design evidence, and test reports. Use
                the local engine to keep practice records on your computer. A different remote
                server can receive code for execution.
              </p>
            </>
          )}
          <label>
            Local Piston URL
            <input
              value={values.pistonUrl}
              disabled={values.managedSandbox}
              onChange={(event) => field('pistonUrl', event.target.value)}
              required
            />
          </label>
          <SandboxSettings
            enabled={values.managedSandbox}
            beforeAction={beforeAction}
            onEnabled={() => {
              field('managedSandbox', true);
              field('pistonUrl', MANAGED_PISTON_URL);
            }}
          />
          {(settings.managedSandbox || values.managedSandbox) && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={values.managedSandbox}
                onChange={(event) => field('managedSandbox', event.target.checked)}
              />
              Start the app-owned sandbox for local code execution
            </label>
          )}
        </fieldset>
        <DistributionSettings beforeAction={beforeAction} />
        {error && (
          <p className="inline-error" role="alert" tabIndex={-1} ref={errorElement}>
            {error}
          </p>
        )}
        <footer>
          <span>
            {values.connection === 'local'
              ? 'Practice records stay on your computer.'
              : 'Draft files stay local. Remote practice records go to the selected service.'}
          </span>
          <button className="primary" disabled={busy}>
            {saving ? 'Connecting…' : 'Save & connect'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
