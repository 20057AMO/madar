import { useEffect, useRef, useState, useCallback, useId } from 'preact/hooks';
import { Keyboard, Package, Settings2 } from 'lucide-preact';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl, type Project } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { canUseTerminalMode, type TerminalMode as TermMode } from '../lib/terminal-access';
type TermStatus = 'connecting' | 'ready' | 'closed' | 'error' | 'exited';

const THEME = {
  background: '#121318',
  foreground: '#e8e9ea',
  cursor: '#e8e9ea',
  cursorAccent: '#121318',
  selectionBackground: 'rgba(155,160,168,0.25)',
  black: '#0f1014',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#e8e9ea',
  brightBlack: '#8b8f98',
  brightRed: '#f85149',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 13;
const MAX_HISTORY = 100;
const MAX_HISTORY_ITEM_LENGTH = 2000;
const TERMINAL_SCROLLBACK = 2000;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 5;

function clampFontSize(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_FONT_SIZE;
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (raw === '') return DEFAULT_FONT_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(parsed)));
}

// Mirrors the close-code contract in backend/src/services/terminal-close.ts — keep both in sync.
const TERMINAL_CLOSE = {
  sessionEnded: 4000,
  containerMissing: 4404,
  containerStopped: 4409,
  capacity: 4503,
  internal: 4500,
  accessDenied: 1008,
  roomLimit: 1013,
} as const;

interface Tab {
  id: string;
  label: string;
  mode: TermMode;
}

function getHistoryKey(slug: string, mode: TermMode): string {
  return `wsd.term.history.${slug}.${mode}`;
}

function sanitizeHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const HISTORY_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;
  return raw
    .filter((item): item is string => typeof item === 'string' && !HISTORY_CONTROL.test(item))
    .map((item) => item.slice(0, MAX_HISTORY_ITEM_LENGTH))
    .slice(-MAX_HISTORY);
}

function loadHistory(slug: string, mode: TermMode): string[] {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(getHistoryKey(slug, mode)) || '[]'));
  } catch {
    return [];
  }
}

function saveHistory(slug: string, mode: TermMode, hist: string[]): void {
  try {
    localStorage.setItem(getHistoryKey(slug, mode), JSON.stringify(sanitizeHistory(hist.slice(-MAX_HISTORY))));
  } catch { /* ignore */ }
}

let tabSeq = 0;

interface TabsState { tabs: Tab[]; activeId: string; }
interface TabsDecision extends TabsState { focusId: string | null; }
type TabsAction =
  | { type: 'add'; tab: Tab }
  | { type: 'close'; id: string; firstLabel: string }
  | { type: 'switch-mode'; id: string; mode: TermMode }
  | { type: 'select'; id: string };

function tabsReducer(prev: TabsState, action: TabsAction): TabsDecision {
  switch (action.type) {
    case 'add':
      return { tabs: [...prev.tabs, action.tab], activeId: action.tab.id, focusId: null };
    case 'close': {
      const remaining = prev.tabs.filter((tab) => tab.id !== action.id);
      if (remaining.length === 0) {
        const id = `t-${Date.now()}-${++tabSeq}`;
        return { tabs: [{ id, label: action.firstLabel, mode: 'project' }], activeId: id, focusId: id };
      }
      const activeId = action.id === prev.activeId ? remaining[remaining.length - 1].id : prev.activeId;
      return { tabs: remaining, activeId, focusId: activeId };
    }
    case 'switch-mode':
      if (prev.tabs.some((tab) => tab.id !== action.id && tab.mode === action.mode)) {
        return { ...prev, focusId: null };
      }
      return {
        ...prev,
        tabs: prev.tabs.map((tab) => (tab.id === action.id ? { ...tab, mode: action.mode } : tab)),
        focusId: null,
      };
    case 'select':
      return { tabs: prev.tabs, activeId: action.id, focusId: null };
  }
}

export function ProjectTerminal({ slug, project }: { slug: string; project: Project | null }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const TERMINAL_STOP_NOTICE: Record<number, string> = {
    [TERMINAL_CLOSE.accessDenied]: t('terminal.notice.accessDenied'),
    [TERMINAL_CLOSE.sessionEnded]: t('terminal.notice.shellExited'),
    [TERMINAL_CLOSE.containerMissing]: t('terminal.notice.containerMissing'),
    [TERMINAL_CLOSE.containerStopped]: t('terminal.notice.containerStopped'),
    [TERMINAL_CLOSE.capacity]: t('terminal.notice.capacity'),
  };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastErrorRef = useRef('');
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [closeNotice, setCloseNotice] = useState('');
  const [workPath, setWorkPath] = useState('');
  const [a11yKeys, setA11yKeys] = useState(() => {
    try { return localStorage.getItem('wsd.terminal.a11yKeys') === 'true'; }
    catch { return false; }
  });
  const [fontSize, setFontSize] = useState(() => {
    try { return clampFontSize(localStorage.getItem('wsd.term.fontSize')); }
    catch { return DEFAULT_FONT_SIZE; }
  });
  const [tabState, setTabState] = useState<TabsState>(() => {
    const first: Tab = { id: `t-${Date.now()}-${++tabSeq}`, label: t('terminal.tabs.first'), mode: 'project' };
    return { tabs: [first], activeId: first.id };
  });
  const tabs = tabState.tabs;
  const activeTabId = tabState.activeId;
  const tabsStateRef = useRef<TabsState>(tabState);
  const [history, setHistory] = useState<string[]>(() => loadHistory(slug, 'project'));
  const [historyIdx, setHistoryIdx] = useState(-1);
  const historyRef = useRef<string[]>(history);
  const historyIdxRef = useRef(historyIdx);
  const fontSizeRef = useRef(fontSize);
  const statusRef = useRef(status);
  const a11yKeysRef = useRef(a11yKeys);
  const a11yToggleRef = useRef<HTMLButtonElement | null>(null);
  const tabsBarRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const dispatchTabs = useCallback((action: TabsAction) => {
    const prev = tabsStateRef.current;
    const next = tabsReducer(prev, action);
    if (next.tabs === prev.tabs && next.activeId === prev.activeId) return;
    tabsStateRef.current = { tabs: next.tabs, activeId: next.activeId };
    if (next.focusId) pendingFocusRef.current = next.focusId;
    setTabState(tabsStateRef.current);
  }, []);
  const panelId = useId();

  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { historyIdxRef.current = historyIdx; }, [historyIdx]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { a11yKeysRef.current = a11yKeys; }, [a11yKeys]);
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const bar = tabsBarRef.current;
    const target = bar?.querySelector<HTMLElement>(`[data-term-tab-close="${id}"]`)
      || bar?.querySelector<HTMLElement>(`[data-term-tab="${id}"]`);
    target?.focus();
    pendingFocusRef.current = null;
  }, [tabs, activeTabId]);

  const toggleA11yKeys = () => {
    const next = !a11yKeysRef.current;
    a11yKeysRef.current = next;
    setA11yKeys(next);
    try { localStorage.setItem('wsd.terminal.a11yKeys', String(next)); } catch { return; }
  };

  const canSendStdin = () =>
    termRef.current?.options.disableStdin === false && wsRef.current?.readyState === 1;

  const sendStdin = (data: string | Uint8Array): boolean => {
    const ws = wsRef.current;
    if (!canSendStdin() || !ws) return false;
    ws.send(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    return true;
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const currentMode = activeTab?.mode || 'project';
  const projectModeAllowed = canUseTerminalMode(user, project, 'project');
  const controlModeAllowed = canUseTerminalMode(user, project, 'control');
  const modeAllowed = currentMode === 'control' ? controlModeAllowed : projectModeAllowed;
  const denied = !modeAllowed;
  const allowedModes: TermMode[] = [
    ...(projectModeAllowed ? ['project' as const] : []),
    ...(controlModeAllowed ? ['control' as const] : []),
  ];

  // Backend allows only 1 session per slug:mode. Determine which modes are taken.
  const takenModes = new Set(tabs.map((t) => t.mode));
  const canAddTab = allowedModes.some((mode) => !takenModes.has(mode)); // max one session per allowed mode

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = clampFontSize(prev + delta);
      try { localStorage.setItem('wsd.term.fontSize', String(next)); } catch { /* blocked */ }
      requestAnimationFrame(() => {
        const term = termRef.current;
        if (term) {
          term.options.fontSize = next;
          fitRef.current?.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        }
      });
      return next;
    });
  }, []);

  const addTab = useCallback(() => {
    const usedModes = new Set(tabs.map((tab) => tab.mode));
    const newMode = allowedModes.find((mode) => !usedModes.has(mode));
    if (!newMode) return;
    const id = `t-${Date.now()}-${++tabSeq}`;
    const newTab: Tab = { id, label: newMode === 'project' ? t('terminal.tabs.project') : t('terminal.tabs.control'), mode: newMode };
    dispatchTabs({ type: 'add', tab: newTab });
  }, [allowedModes, tabs, t, dispatchTabs]);

  const closeTab = useCallback((id: string) => {
    dispatchTabs({ type: 'close', id, firstLabel: t('terminal.tabs.first') });
  }, [dispatchTabs, t]);

  const switchTabMode = useCallback((id: string, newMode: TermMode) => {
    dispatchTabs({ type: 'switch-mode', id, mode: newMode });
  }, [dispatchTabs]);

  useEffect(() => {
    setHistory(loadHistory(slug, currentMode));
    setHistoryIdx(-1);
  }, [slug, currentMode]);

  // Auto-reconnect logic
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** reconnectAttemptRef.current,
      RECONNECT_MAX_MS
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;
      setReconnectNonce((n) => n + 1);
    }, delay);
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
  }, []);

  const cancelNotice = useCallback(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const announceNotice = useCallback((text: string) => {
    cancelNotice();
    setCloseNotice('');
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setCloseNotice(text);
    }, 0);
  }, [cancelNotice]);

  const manualReconnect = useCallback(() => {
    if (!modeAllowed) return;
    cancelReconnect();
    cancelNotice();
    reconnectAttemptRef.current = 0;
    lastErrorRef.current = '';
    setCloseNotice('');
    setReconnectNonce((n) => n + 1);
  }, [modeAllowed, cancelReconnect, cancelNotice]);

  // Cancel reconnect on tab switch
  useEffect(() => {
    return () => cancelReconnect();
  }, [currentMode, slug, cancelReconnect]);

  useEffect(() => {
    if (modeAllowed) return;
    cancelReconnect();
    cancelNotice();
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    }
    const term = termRef.current;
    if (term) term.options.disableStdin = true;
    setCloseNotice('');
    setWorkPath('');
  }, [modeAllowed, cancelReconnect, cancelNotice]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !modeAllowed) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: clampFontSize(fontSizeRef.current),
      lineHeight: 1.4,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace',
      theme: THEME,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      scrollback: TERMINAL_SCROLLBACK,
      disableStdin: true,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (!canSendStdin()) return false;

      if (e.type !== 'keydown') return true;

      if (a11yKeysRef.current && e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'm' || e.key === 'M')) return false;

      if (a11yKeysRef.current && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Escape')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          a11yToggleRef.current?.focus();
        }
        return false;
      }

      if (e.key === 'ArrowUp') {
        const hist = historyRef.current;
        if (hist.length === 0) return true;
        const newIdx = historyIdxRef.current < 0
          ? hist.length - 1
          : Math.max(0, historyIdxRef.current - 1);
        const cmd = hist[newIdx];
        if (cmd && sendStdin('\x1b[2K\r' + cmd)) {
          setHistoryIdx(newIdx);
        }
        e.preventDefault();
        e.stopPropagation();
        return false;
      }

      if (e.key === 'ArrowDown') {
        if (historyIdxRef.current < 0) return true;
        const newIdx = historyIdxRef.current + 1;
        const hist = historyRef.current;
        if (newIdx >= hist.length) {
          if (sendStdin('\x1b[2K\r')) {
            setHistoryIdx(-1);
          }
        } else {
          const cmd = hist[newIdx];
          if (cmd && sendStdin('\x1b[2K\r' + cmd)) {
            setHistoryIdx(newIdx);
          }
        }
        e.preventDefault();
        e.stopPropagation();
        return false;
      }

      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        term.clear();
        return false;
      }

      return true;
    });

    let ro: ResizeObserver | null = null;
    const startTimer = window.setTimeout(() => fit.fit(), 100);

    const onData = (data: string) => {
      sendStdin(new TextEncoder().encode(data));
    };
    const onResize = () => {
      if (!host) return;
      try { fit.fit(); } catch { return; }
      const ws = wsRef.current;
      const activeTerm = termRef.current;
      if (ws && ws.readyState === 1 && activeTerm) {
        ws.send(JSON.stringify({ type: 'resize', cols: activeTerm.cols, rows: activeTerm.rows }));
      }
    };
    const termDisposer = term.onData(onData);
    const resizeDisposer = term.onResize(onResize);
    ro = new ResizeObserver(() => onResize());
    ro.observe(host);

    const wheelHandler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        changeFontSize(e.deltaY < 0 ? 1 : -1);
      }
    };
    host.addEventListener('wheel', wheelHandler, { passive: false });

    return () => {
      window.clearTimeout(startTimer);
      termDisposer.dispose();
      resizeDisposer.dispose();
      ro?.disconnect();
      host.removeEventListener('wheel', wheelHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [slug, currentMode, modeAllowed, changeFontSize]);

  useEffect(() => {
    if (!modeAllowed) return;
    lastErrorRef.current = '';
    setStatus('connecting');
    setCloseNotice('');
    setWorkPath('');

    let disposed = false;
    const url = wsUrl(`/ws/projects/${encodeURIComponent(slug)}/terminal?mode=${currentMode}`);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const sendResize = () => {
      const term = termRef.current;
      if (term && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      fitRef.current?.fit();
      sendResize();
    };
    ws.onclose = (ev: CloseEvent) => {
      if (disposed) return;
      const term = termRef.current;
      if (term) term.options.disableStdin = true;
      const stop = TERMINAL_STOP_NOTICE[ev.code] || '';
      if (ev.code === TERMINAL_CLOSE.sessionEnded) {
        const notice = lastErrorRef.current || stop;
        setStatus('exited');
        announceNotice(notice);
        term?.write(`\r\n\x1b[1;33m${notice}\x1b[0m\r\n`);
        return;
      }
      if (ev.code === TERMINAL_CLOSE.roomLimit) {
        cancelReconnect();
        setStatus('error');
        announceNotice(t('terminal.notice.roomLimit'));
        term?.write('\r\n\x1b[1;33m' + t('terminal.notice.roomLimit') + '\x1b[0m\r\n');
        return;
      }
      if (stop) {
        const notice = lastErrorRef.current || ev.reason || stop;
        setStatus(lastErrorRef.current ? 'error' : 'closed');
        announceNotice(notice);
        term?.write(`\r\n\x1b[1;33m${notice}\x1b[0m\r\n`);
        return;
      }
      const reasonNotice = lastErrorRef.current || ev.reason || '';
      if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        const notice = reasonNotice || t('terminal.notice.connectionLost', { code: ev.code });
        setStatus('error');
        announceNotice(notice);
        term?.write(`\r\n\x1b[1;31m${notice}\x1b[0m\r\n`);
        return;
      }
      setStatus(lastErrorRef.current ? 'error' : 'closed');
      announceNotice(reasonNotice);
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (disposed) return;
      if (!lastErrorRef.current) lastErrorRef.current = t('terminal.notice.socketError');
      const term = termRef.current;
      if (term) term.options.disableStdin = true;
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (disposed) return;
      const term = termRef.current;
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') {
            reconnectAttemptRef.current = 0;
            lastErrorRef.current = '';
            cancelNotice();
            setStatus('ready');
            setCloseNotice('');
            if (term) {
              term.options.disableStdin = false;
              fitRef.current?.fit();
            }
            sendResize();
          } else if (msg.type === 'error') {
            setStatus('error');
            const message = String(msg.message || t('terminal.notice.terminalError'));
            lastErrorRef.current = message;
            term?.writeln('\r\n\x1b[1;31m' + message + '\x1b[0m\r\n');
          } else if (msg.type === 'path') {
            setWorkPath(msg.subdir || msg.path || '');
          }
        } catch { /* ignore */ }
      } else {
        term?.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      cancelNotice();
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
      const term = termRef.current;
      if (term) term.options.disableStdin = true;
    };
  }, [slug, currentMode, modeAllowed, reconnectNonce, scheduleReconnect, announceNotice, cancelNotice]);

  const sendCommand = useCallback((cmd: string) => {
    if (!modeAllowed || !sendStdin(cmd + '\r')) return;
    const trimmed = cmd.trim();
    if (trimmed) {
      setHistory((prev) => {
        if (trimmed === prev[prev.length - 1]) return prev;
        const next = sanitizeHistory([...sanitizeHistory(prev), trimmed].slice(-MAX_HISTORY));
        saveHistory(slug, currentMode, next);
        return next;
      });
      setHistoryIdx(-1);
    }
  }, [slug, currentMode, modeAllowed]);

  const quickCmds =
    currentMode === 'project'
      ? ['git status', 'git log --oneline -10', 'npm run build', 'ls -la', 'cat package.json']
      : ['docker ps', `docker logs wsd-${slug} --tail 30`, 'git status', 'df -h', 'free -m'];

  const statusLabel = denied
    ? t('terminal.status.readOnly')
    : status === 'ready'
      ? t('terminal.status.connected')
      : status === 'connecting'
        ? t('terminal.status.connecting')
        : status === 'exited'
          ? t('terminal.status.exited')
          : status === 'closed'
            ? t('terminal.status.closed')
            : t('terminal.status.error');
  const accessTitleKey = currentMode === 'control' ? 'terminal.access.controlTitle' : 'terminal.access.projectTitle';
  const accessBodyKey = currentMode === 'control' ? 'terminal.access.controlBody' : 'terminal.access.projectBody';

  const onTabListKeyDown = (e: KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const list = tabsStateRef.current.tabs.map((tab) => tab.id);
    if (list.length === 0) return;
    let idx = list.indexOf(activeTabId);
    if (e.key === 'ArrowRight') idx = (idx + 1) % list.length;
    else if (e.key === 'ArrowLeft') idx = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = list.length - 1;
    e.preventDefault();
    const nextId = list[idx];
    dispatchTabs({ type: 'select', id: nextId });
    const bar = e.currentTarget as HTMLElement;
    bar.querySelector<HTMLElement>(`[data-term-tab="${nextId}"]`)?.focus();
  };

  return (
    <div class="term-wrap">
      {/* ── Tabs Bar ── */}
      <div class="term-tabs-bar">
        <div ref={tabsBarRef} class="term-tabs-list" role="tablist" aria-label={t('terminal.tabs.aria')} onKeyDown={onTabListKeyDown}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              id={`${panelId}-tab-${tab.id}`}
              data-term-tab={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              aria-controls={panelId}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              class={`term-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => dispatchTabs({ type: 'select', id: tab.id })}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  dispatchTabs({ type: 'select', id: tab.id });
                }
              }}
            >
              <span class="term-tab-mode-dot" title={tab.mode === 'project' ? t('terminal.tabs.projectShell') : t('terminal.tabs.controlShell')} />
              <span class="term-tab-label">{tab.label}</span>
              {tabs.length > 1 && (
                <button class="term-tab-close" data-term-tab-close={tab.id} tabIndex={0} onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} title={t('terminal.tabs.close')} aria-label={t('terminal.tabs.closeAria', { label: tab.label })}>×</button>
              )}
            </div>
          ))}
          {canAddTab && (
            <button class="term-tab-add" onClick={addTab} title={t('terminal.tabs.add')} aria-label={t('terminal.tabs.add')}>+</button>
          )}
        </div>
      </div>

      {/* ── Header ── */}
      <div class="term-header">
        <div class="term-header-left">
          <span class={`term-status-dot ${denied ? 'read-only' : status}`} title={statusLabel} aria-hidden="true" />
          <div
            class="term-header-live"
            role="status"
            aria-live="polite"
            aria-hidden={denied ? true : undefined}
            aria-atomic="true"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}
          >
            <span class="term-header-label">{statusLabel}</span>
            {closeNotice && <span class="term-close-notice" title={closeNotice}>{closeNotice}</span>}
          </div>
          {(status === 'closed' || status === 'error' || status === 'exited') && (
            <button
              class="term-reconnect-btn"
              onClick={manualReconnect}
              aria-disabled={denied}
              title={status === 'exited' ? t('terminal.action.startShell') : t('terminal.action.reconnect')}
              aria-label={status === 'exited' ? t('terminal.action.startShell') : t('terminal.action.reconnect')}
            >
              {status === 'exited' ? `↻ ${t('terminal.action.startShell')}` : `↻ ${t('terminal.action.reconnect')}`}
            </button>
          )}
        </div>

        {workPath && (
          <div class="term-header-path" title={workPath}>
            <span class="term-path-icon">/</span>
            <span class="term-path-text mono">{workPath}</span>
          </div>
        )}

        <div class="term-controls">
          <div class="term-font-controls">
            <button class="term-ctrl-btn" onClick={() => changeFontSize(-1)} title={t('terminal.action.zoomOut')} aria-label={t('terminal.action.zoomOutAria')}>A-</button>
            <span class="term-font-label" aria-live="polite" aria-atomic="true">{fontSize}px</span>
            <button class="term-ctrl-btn" onClick={() => changeFontSize(1)} title={t('terminal.action.zoomIn')} aria-label={t('terminal.action.zoomInAria')}>A+</button>
            <button class="term-ctrl-btn" onClick={() => changeFontSize(DEFAULT_FONT_SIZE - fontSize)} title={t('terminal.action.resetFont')} aria-label={t('terminal.action.resetFont')}>↺</button>
          </div>

          <div class="term-font-controls">
            <button
              ref={a11yToggleRef}
              class="term-ctrl-btn"
              onClick={toggleA11yKeys}
              title={t('terminal.action.a11yKeys')}
              aria-label={t('terminal.action.a11yKeys')}
              aria-pressed={a11yKeys}
            >
              <Keyboard width={12} height={12} class="icon" />
            </button>
          </div>

          <div class="term-mode-switch">
            <button
              class={`term-mode-btn ${currentMode === 'project' ? 'active' : ''}`}
              onClick={() => { activeTab && switchTabMode(activeTab.id, 'project'); }}
              disabled={currentMode !== 'project' && tabs.some((tab) => tab.id !== activeTabId && tab.mode === 'project')}
              title={t('terminal.action.modeProject')}
            >
              <span class="term-mode-icon"><Package width={12} height={12} class="icon" /> {t('terminal.tabs.project')}</span>
            </button>
            <button
              class={`term-mode-btn ${currentMode === 'control' ? 'active' : ''}`}
              onClick={() => { activeTab && switchTabMode(activeTab.id, 'control'); }}
              disabled={currentMode !== 'control' && tabs.some((tab) => tab.id !== activeTabId && tab.mode === 'control')}
              title={t('terminal.action.modeControl')}
            >
              <span class="term-mode-icon"><Settings2 width={12} height={12} class="icon" /> {t('terminal.tabs.control')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Quick commands ── */}
      <div class="term-quick-row">
        {quickCmds.map((c, i) => (
          <button class="term-quick-btn" key={i} aria-disabled={denied} onClick={() => sendCommand(c)}>
            {c}
          </button>
        ))}
      </div>

      {/* ── Terminal canvas ── */}
      <div
        class="term-host mono"
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${activeTab.id}`}
        ref={hostRef}
        onClick={() => { if (!denied) termRef.current?.focus(); }}
      >
        {denied && (
          <div
            class="term-access-panel"
            role="status"
            aria-live="polite"
            aria-label={t('terminal.access.aria')}
            data-term-access-denied={currentMode}
          >
            <strong>{t(accessTitleKey)}</strong>
            <p>{t(accessBodyKey)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
