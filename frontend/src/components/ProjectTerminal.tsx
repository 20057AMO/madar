import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { Package, Settings2 } from 'lucide-preact';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from '../api';

type TermMode = 'project' | 'control';
type TermStatus = 'connecting' | 'ready' | 'closed' | 'error';

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
  brightBlack: '#5c6068',
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
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;

interface Tab {
  id: string;
  label: string;
  mode: TermMode;
}

function getHistoryKey(slug: string, mode: TermMode): string {
  return `wsd.term.history.${slug}.${mode}`;
}

function loadHistory(slug: string, mode: TermMode): string[] {
  try {
    return JSON.parse(localStorage.getItem(getHistoryKey(slug, mode)) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(slug: string, mode: TermMode, hist: string[]): void {
  try {
    localStorage.setItem(getHistoryKey(slug, mode), JSON.stringify(hist.slice(-MAX_HISTORY)));
  } catch { /* ignore */ }
}

let tabSeq = 0;

export function ProjectTerminal({ slug }: { slug: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [workPath, setWorkPath] = useState('');
  const [fontSize, setFontSize] = useState(() => {
    try { return parseInt(localStorage.getItem('wsd.term.fontSize') || String(DEFAULT_FONT_SIZE), 10); }
    catch { return DEFAULT_FONT_SIZE; }
  });
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: `t-${Date.now()}-${++tabSeq}`, label: 'Terminal 1', mode: 'project' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id || '');
  const [history, setHistory] = useState<string[]>(() => loadHistory(slug, 'project'));
  const [historyIdx, setHistoryIdx] = useState(-1);
  const historyRef = useRef<string[]>(history);
  const historyIdxRef = useRef(historyIdx);
  const fontSizeRef = useRef(fontSize);
  const statusRef = useRef(status);

  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { historyIdxRef.current = historyIdx; }, [historyIdx]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { statusRef.current = status; }, [status]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const currentMode = activeTab?.mode || 'project';

  // Backend allows only 1 session per slug:mode. Determine which modes are taken.
  const takenModes = new Set(tabs.map((t) => t.mode));
  const canAddTab = takenModes.size < 2; // project + control = max 2

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta));
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
    if (!canAddTab) return;
    const usedModes = new Set(tabs.map((t) => t.mode));
    const newMode: TermMode = usedModes.has('project') ? 'control' : 'project';
    const id = `t-${Date.now()}-${++tabSeq}`;
    const newTab: Tab = { id, label: newMode === 'project' ? 'Project' : 'Control', mode: newMode };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  }, [canAddTab, tabs]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const newId = `t-${Date.now()}-${++tabSeq}`;
        next.push({ id: newId, label: 'Terminal 1', mode: 'project' });
        setActiveTabId(newId);
      } else if (id === activeTabId) {
        setActiveTabId(next[next.length - 1].id);
      }
      return next;
    });
  }, [activeTabId]);

  const switchTabMode = useCallback((id: string, newMode: TermMode) => {
    // Check if another tab already uses this mode
    setTabs((prev) => {
      const otherUsesMode = prev.some((t) => t.id !== id && t.mode === newMode);
      if (otherUsesMode) return prev; // can't switch — mode already taken
      return prev.map((t) => (t.id === id ? { ...t, mode: newMode } : t));
    });
  }, []);

  useEffect(() => {
    setHistory(loadHistory(slug, currentMode));
    setHistoryIdx(-1);
  }, [slug, currentMode]);

  // Auto-reconnect logic
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttemptRef.current),
      RECONNECT_MAX_MS
    );
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;
      // Trigger re-render to re-run the terminal effect
      setStatus('connecting');
    }, delay);
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
  }, []);

  const manualReconnect = useCallback(() => {
    cancelReconnect();
    reconnectAttemptRef.current = 0;
    setStatus('connecting');
  }, [cancelReconnect]);

  // Cancel reconnect on tab switch
  useEffect(() => {
    return () => cancelReconnect();
  }, [currentMode, slug, cancelReconnect]);

  useEffect(() => {
    // Don't connect if we're in a transient 'connecting' state from auto-reconnect
    // and the previous status was closed/error — allow the effect to run
    if (status === 'closed' || status === 'error') {
      scheduleReconnect();
      return;
    }

    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      lineHeight: 1.4,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace',
      theme: THEME,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;

      if (e.key === 'ArrowUp') {
        const hist = historyRef.current;
        if (hist.length === 0) return true;
        const newIdx = historyIdxRef.current < 0
          ? hist.length - 1
          : Math.max(0, historyIdxRef.current - 1);
        setHistoryIdx(newIdx);
        const cmd = hist[newIdx];
        if (cmd) {
          const ws = wsRef.current;
          if (ws && ws.readyState === 1) {
            ws.send(new TextEncoder().encode('\x1b[2K\r' + cmd));
          }
        }
        return false;
      }

      if (e.key === 'ArrowDown') {
        if (historyIdxRef.current < 0) return true;
        const newIdx = historyIdxRef.current + 1;
        const hist = historyRef.current;
        const ws = wsRef.current;
        if (newIdx >= hist.length) {
          setHistoryIdx(-1);
          if (ws && ws.readyState === 1) {
            ws.send(new TextEncoder().encode('\x1b[2K\r'));
          }
        } else {
          setHistoryIdx(newIdx);
          const cmd = hist[newIdx];
          if (cmd && ws && ws.readyState === 1) {
            ws.send(new TextEncoder().encode('\x1b[2K\r' + cmd));
          }
        }
        return false;
      }

      if (e.ctrlKey && e.key === 'l') {
        term.clear();
        return false;
      }

      return true;
    });

    let disposed = false;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    const startTimer = window.setTimeout(() => fit.fit(), 100);

    const url = wsUrl(`/ws/projects/${encodeURIComponent(slug)}/terminal?mode=${currentMode}`);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setStatus('connecting');
    cancelReconnect();

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setStatus('ready');
      fit.fit();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    ws.onclose = () => {
      if (!disposed) {
        setStatus('closed');
        scheduleReconnect();
      }
    };
    ws.onerror = () => {
      if (!disposed) {
        setStatus('error');
        scheduleReconnect();
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error') {
            setStatus('error');
            term.writeln('\r\n\x1b[1;31m' + (String(msg.message || 'Terminal error')) + '\x1b[0m\r\n');
          } else if (msg.type === 'path') {
            if (!disposed) setWorkPath(msg.subdir || msg.path || '');
          }
        } catch { /* ignore */ }
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    const onData = (data: string) => {
      if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(data));
    };
    const onResize = () => {
      if (disposed || !host) return;
      try { fit.fit(); } catch { return; }
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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
      disposed = true;
      window.clearTimeout(startTimer);
      ws?.close();
      wsRef.current = null;
      termDisposer.dispose();
      resizeDisposer.dispose();
      ro?.disconnect();
      host.removeEventListener('wheel', wheelHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [slug, currentMode, changeFontSize, scheduleReconnect, cancelReconnect]);

  const sendCommand = useCallback((cmd: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(new TextEncoder().encode(cmd + '\r'));
      const trimmed = cmd.trim();
      if (trimmed) {
        setHistory((prev) => {
          if (trimmed === prev[prev.length - 1]) return prev;
          const next = [...prev, trimmed];
          saveHistory(slug, currentMode, next);
          return next;
        });
        setHistoryIdx(-1);
      }
    }
  }, [slug, currentMode]);

  const quickCmds =
    currentMode === 'project'
      ? ['git status', 'git log --oneline -10', 'npm run build', 'ls -la', 'cat package.json']
      : ['docker ps', `docker logs wsd-${slug} --tail 30`, 'git status', 'df -h', 'free -m'];

  const statusLabel = status === 'ready' ? 'connected' : status === 'connecting' ? 'connecting…' : status === 'closed' ? 'disconnected' : 'error';

  const onTabListKeyDown = (e: KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const list = tabs.map((t) => t.id);
    if (list.length === 0) return;
    let idx = list.indexOf(activeTabId);
    if (e.key === 'ArrowRight') idx = (idx + 1) % list.length;
    else if (e.key === 'ArrowLeft') idx = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = list.length - 1;
    e.preventDefault();
    const nextId = list[idx];
    setActiveTabId(nextId);
    const bar = e.currentTarget as HTMLElement;
    bar.querySelector<HTMLElement>(`[data-term-tab="${nextId}"]`)?.focus();
  };

  return (
    <div class="term-wrap">
      {/* ── Tabs Bar ── */}
      <div class="term-tabs-bar">
        <div class="term-tabs-list" role="tablist" aria-label="Terminal tabs" onKeyDown={onTabListKeyDown}>
          {tabs.map((t) => (
            <div
              key={t.id}
              data-term-tab={t.id}
              role="tab"
              aria-selected={t.id === activeTabId}
              tabIndex={t.id === activeTabId ? 0 : -1}
              class={`term-tab ${t.id === activeTabId ? 'active' : ''}`}
              onClick={() => setActiveTabId(t.id)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveTabId(t.id);
                }
              }}
            >
              <span class="term-tab-mode-dot" title={t.mode === 'project' ? 'Project shell' : 'Control shell'} />
              <span class="term-tab-label">{t.label}</span>
              {tabs.length > 1 && (
                <button class="term-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} title="Close tab" aria-label={`Close tab ${t.label}`}>×</button>
              )}
            </div>
          ))}
          {canAddTab && (
            <button class="term-tab-add" onClick={addTab} title="New terminal tab" aria-label="New terminal tab">+</button>
          )}
        </div>
      </div>

      {/* ── Header ── */}
      <div class="term-header">
        <div class="term-header-left">
          <span class={`term-status-dot ${status}`} title={statusLabel} />
          <span class="term-header-label" role="status">{statusLabel}</span>
          {(status === 'closed' || status === 'error') && (
            <button class="term-reconnect-btn" onClick={manualReconnect} title="Reconnect" aria-label="Reconnect">
              ↻ Reconnect
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
            <button class="term-ctrl-btn" onClick={() => changeFontSize(-1)} title="Zoom out (Ctrl+Scroll)">A-</button>
            <span class="term-font-label">{fontSize}px</span>
            <button class="term-ctrl-btn" onClick={() => changeFontSize(1)} title="Zoom in (Ctrl+Scroll)">A+</button>
            <button class="term-ctrl-btn" onClick={() => changeFontSize(DEFAULT_FONT_SIZE - fontSize)} title="Reset font size" aria-label="Reset font size">↺</button>
          </div>

          <div class="term-mode-switch">
            <button
              class={`term-mode-btn ${currentMode === 'project' ? 'active' : ''}`}
              onClick={() => activeTab && switchTabMode(activeTab.id, 'project')}
              disabled={currentMode !== 'project' && tabs.some((t) => t.id !== activeTabId && t.mode === 'project')}
              title="Shell inside the project container (dev toolchain)"
            >
              <span class="term-mode-icon"><Package width={12} height={12} class="icon" /> Project</span>
            </button>
            <button
              class={`term-mode-btn ${currentMode === 'control' ? 'active' : ''}`}
              onClick={() => activeTab && switchTabMode(activeTab.id, 'control')}
              disabled={currentMode !== 'control' && tabs.some((t) => t.id !== activeTabId && t.mode === 'control')}
              title="Shell in the app container (git + docker CLI)"
            >
              <span class="term-mode-icon"><Settings2 width={12} height={12} class="icon" /> Control</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Quick commands ── */}
      <div class="term-quick-row">
        {quickCmds.map((c, i) => (
          <button class="term-quick-btn" key={i} onClick={() => sendCommand(c)}>
            {c}
          </button>
        ))}
      </div>

      {/* ── Terminal canvas ── */}
      <div
        class="term-host mono"
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}
