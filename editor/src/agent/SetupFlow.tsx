// First-run setup of the design agent (omp): install -> sign in -> verified ready. Shown in the agent panel
// instead of the chat until omp can answer. Every state has a next action; while Terminal works the panel
// re-checks quietly, so nothing needs a manual "Check again" (it stays as an escape hatch).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentInfo } from '../bridge/schema.gen';
import { Icon } from '../app/Icon';
import { SwapIcon } from '../app/Crossfade';
import type { AgentChat } from './AgentChat';

const POLL_MS = 3000;

type Step = 'install' | 'signin' | 'ready';

/** Set once this window showed an install or sign-in screen, so "ready" is confirmed instead of silently swapping in the chat. */
let journey: 'none' | 'seen' | 'dismissed' = 'none';
const markSeen = () => {
  if (journey === 'none') journey = 'seen';
};

function Steps({ at }: { at: Step }) {
  const order: Step[] = ['install', 'signin', 'ready'];
  const labels: Record<Step, string> = { install: 'Install omp', signin: 'Sign in to a model provider', ready: 'Start designing' };
  return (
    <ol className="at-setup__steps" aria-label="Setup steps">
      {order.map((step, i) => {
        const state = at === 'ready' || i < order.indexOf(at) ? 'done' : step === at ? 'current' : 'todo';
        return (
          <li key={step} className={`at-setup__step at-setup__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="at-setup__marker" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size={12} /> : i + 1}
            </span>
            {labels[step]}
          </li>
        );
      })}
    </ol>
  );
}

function Command({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="at-setup__cmd">
      <code>{text}</code>
      <button
        type="button"
        className="at-btn at-btn--withicon"
        onClick={() => {
          void onCopy(text).then(() => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        <SwapIcon on={copied}>
          <Icon name="copy" size={12} />
          <Icon name="check" size={12} />
        </SwapIcon>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Re-checks every few seconds while `active` (Terminal is installing or signing in), one check at a time. */
function useQuietRecheck(chat: AgentChat, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      await chat.refreshStatus({ quiet: true });
      if (!stopped) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [chat, active]);
}

const INSTALL_COPY: Record<string, string> = {
  bun: 'Ocelot runs this in Terminal with the bun on this Mac:',
  npm: 'omp runs on bun, which you do not have yet. This Mac has npm, so Terminal installs bun with it, then omp:',
  none: 'omp runs on bun, which you do not have yet. Terminal downloads it from bun.sh (its official installer), then installs omp:',
};

/** omp missing, or installed but not running. `info` is absent when the host could not answer at all. */
export function Setup({ chat, message, info }: { chat: AgentChat; message: string; info?: AgentInfo }) {
  useEffect(markSeen, []);
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useQuietRecheck(chat, waiting);
  const retry = () => void chat.refreshStatus();

  // No way to install from here (a browser tab, the bridge failed) or omp runs but the agent cannot start (the sandbox
  // failed): the host's message says what to do; retry is the only action.
  if (!info?.installCommand) {
    return (
      <div className="at-agent__intro">
        <h2 className="at-agent__heading">{info?.version ? 'The agent could not start' : 'Connect omp'}</h2>
        <p>{message}</p>
        <div className="at-agent__actions">
          <button type="button" className="at-agent__primary" onClick={retry}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  const command = info.installCommand;
  const canRun = Boolean(info.installer); // only the Mac app can open Terminal
  const broken = Boolean(info.path); // an omp binary exists but does not run
  const install = () => {
    setFailure(null);
    void chat.install().then((err) => {
      if (err) setFailure(err);
      else setWaiting(true);
    });
  };

  let intro: ReactNode;
  if (broken) intro = <p>{message} Reinstalling replaces it:</p>;
  else if (canRun) intro = <p>{INSTALL_COPY[info.installer ?? 'bun'] ?? INSTALL_COPY['bun']}</p>;
  else intro = <p>Run this in a terminal, then check again:</p>;

  return (
    <div className="at-agent__intro" data-testid="agent-setup-install">
      <h2 className="at-agent__heading">{broken ? 'Reinstall omp' : 'Set up the design agent'}</h2>
      {!broken && <p>The agent is omp, a coding agent that runs on your own Claude or ChatGPT subscription. Three quick steps, about a minute.</p>}
      <Steps at="install" />
      {intro}
      <Command text={command} onCopy={(text) => chat.copyText(text)} />
      {failure && <p className="at-setup__error" role="alert">{failure}</p>}
      <div className="at-agent__actions">
        {canRun && (
          <button type="button" className="at-agent__primary" onClick={install} disabled={waiting}>
            {waiting ? 'Installing in Terminal…' : 'Install in Terminal'}
          </button>
        )}
        <button type="button" className={canRun ? 'at-btn' : 'at-agent__primary'} onClick={retry}>
          Check again
        </button>
      </div>
      {waiting && (
        <p className="at-setup__wait" role="status">
          <span className="at-setup__pulse" aria-hidden="true" />
          Waiting for the install to finish. Ocelot continues by itself when omp is there.
        </p>
      )}
    </div>
  );
}

/** omp is installed but has no model it can use. */
export function SignIn({ chat, info }: { chat: AgentChat; info: AgentInfo }) {
  useEffect(markSeen, []);
  const [waiting, setWaiting] = useState(false);
  useQuietRecheck(chat, waiting);
  return (
    <div className="at-agent__intro" data-testid="agent-setup-signin">
      <h2 className="at-agent__heading">Sign in to a model provider</h2>
      <p>
        {info.version ? `omp ${info.version} is installed` : 'omp is installed'} but has no model it can use yet. Sign in with your Claude or ChatGPT subscription. Terminal opens for the sign-in.
      </p>
      <Steps at="signin" />
      <div className="at-agent__actions">
        <button
          type="button"
          className="at-agent__primary"
          disabled={waiting}
          onClick={() => {
            void chat.signIn();
            setWaiting(true);
          }}
        >
          {waiting ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className="at-btn" onClick={() => void chat.refreshStatus()}>
          Check again
        </button>
      </div>
      {waiting && (
        <p className="at-setup__wait" role="status">
          <span className="at-setup__pulse" aria-hidden="true" />
          Finish in Terminal and Ocelot notices when you are signed in.{' '}
          <button type="button" className="at-setup__link" onClick={() => void chat.signIn()}>
            Reopen Terminal
          </button>
        </p>
      )}
    </div>
  );
}

/** The verified last step: shown once after a setup journey, then the normal empty state takes over. */
export function ReadyGate({ info, models, fallback }: { info: AgentInfo; models: number; fallback: ReactNode }) {
  const [, rerender] = useState(0);
  if (journey !== 'seen') return <>{fallback}</>;
  return (
    <div className="at-agent__intro" data-testid="agent-setup-ready">
      <span className="at-setup__badge" aria-hidden="true">
        <Icon name="check" size={16} />
      </span>
      <h2 className="at-agent__heading">The agent is ready</h2>
      <Steps at="ready" />
      <p>
        {[info.version ? `omp ${info.version}` : 'omp', models ? `${models} model${models === 1 ? '' : 's'} available` : null, info.isolation === 'sandboxed' ? 'sandboxed' : null]
          .filter(Boolean)
          .join(' · ')}
        . It edits the canvas through Ocelot’s tools, and ⌘Z undoes everything it does.
      </p>
      <div className="at-agent__actions">
        <button
          type="button"
          className="at-agent__primary"
          onClick={() => {
            journey = 'dismissed';
            rerender((n) => n + 1);
          }}
        >
          Start designing
        </button>
      </div>
    </div>
  );
}
