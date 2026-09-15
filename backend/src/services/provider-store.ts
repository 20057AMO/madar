/**
 * provider-store.ts
 * Madar — Persisted provider credentials.
 * Stored in WSD_DATA_DIR/providers.json. Env vars act as defaults.
 * Providers are fully dynamic: any number of Ollama / OpenAI-compatible /
 * Anthropic endpoints can be added, edited or deleted from the UI.
 */

import fs from 'fs';
import path from 'path';
import { clearProviderRefs } from './agent-store';
import { isSealed, maskStored, openSecret, sealSecret } from './secret-box';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'providers.json');

export type ProviderType = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'azure';
export type AuthMode = 'bearer' | 'api-key';

/**
 * Azure OpenAI data-plane API version used for every Azure request
 * (deployments list, verification, streaming chat). Override with WSD_AZURE_API_VERSION.
 */
export const AZURE_API_VERSION = process.env.WSD_AZURE_API_VERSION || '2024-10-21';

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  host: string;
  apiKey: string;
  /** Header used for OpenAI-compatible providers (some gateways use `api-key`). */
  auth?: AuthMode;
  enabled: boolean;
}

export interface ProviderMeta {
  id: string;
  name: string;
  type: ProviderType;
  host: string;
  apiKeyMasked: string;
  enabled: boolean;
}

export interface KnownTemplate {
  name: string;
  type: ProviderType;
  host: string;
  /** One or more key prefixes that hint at this provider (used to order detection). */
  keyPrefix?: string | string[];
}

export const KNOWN_TEMPLATES: KnownTemplate[] = [
  { name: 'OpenRouter', type: 'openai', host: 'https://openrouter.ai/api/v1', keyPrefix: 'sk-or-v1-' },
  { name: 'OpenAI', type: 'openai', host: 'https://api.openai.com/v1', keyPrefix: 'sk-' },
  { name: 'Google AI Studio (Gemini)', type: 'gemini', host: 'https://generativelanguage.googleapis.com/v1beta', keyPrefix: ['AIza', 'AQ'] },
  { name: 'Anthropic (Claude)', type: 'anthropic', host: 'https://api.anthropic.com', keyPrefix: 'sk-ant-' },
  { name: 'Groq', type: 'openai', host: 'https://api.groq.com/openai/v1', keyPrefix: 'gsk_' },
  { name: 'DeepSeek', type: 'openai', host: 'https://api.deepseek.com/v1', keyPrefix: 'sk-' },
  { name: 'Mistral', type: 'openai', host: 'https://api.mistral.ai/v1' },
  { name: 'Together AI', type: 'openai', host: 'https://api.together.xyz/v1' },
  { name: 'xAI', type: 'openai', host: 'https://api.x.ai/v1', keyPrefix: 'xai-' },
  { name: 'HuggingFace', type: 'openai', host: 'https://router.huggingface.co/v1', keyPrefix: 'hf_' },
  { name: 'Fireworks', type: 'openai', host: 'https://api.fireworks.ai/inference/v1' },
  { name: 'Ollama (Cloud)', type: 'ollama', host: process.env.OLLAMA_HOST || 'https://ollama.com' },
  { name: 'Ollama (Local)', type: 'ollama', host: process.env.OLLAMA_LOCAL_HOST || 'http://host.docker.internal:11434' },
];

function seeded(): Record<string, ProviderConfig> {
  return {
    ollama: {
      name: 'Ollama Cloud',
      type: 'ollama',
      host: process.env.OLLAMA_HOST || 'https://ollama.com',
      apiKey: process.env.OLLAMA_API_KEY || '',
      enabled: true,
    },
    local: {
      name: 'Local Ollama',
      type: 'ollama',
      host: process.env.OLLAMA_LOCAL_HOST || 'http://host.docker.internal:11434',
      apiKey: '',
      enabled: true,
    },
  };
}

let cached: Record<string, ProviderConfig> | null = null;

function load(): Record<string, ProviderConfig> {
  if (cached) return cached;
  let base: Record<string, ProviderConfig>;
  if (fs.existsSync(STORE_FILE)) {
    base = {};
  } else {
    base = seeded();
  }
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Record<
        string,
        Partial<ProviderConfig> | undefined
      >;
      for (const id of Object.keys(raw)) {
        const stored = raw[id];
        if (!stored || typeof stored !== 'object') continue;
        const prev = base[id];
        const resolvedType =
          stored.type === 'ollama' || stored.type === 'openai' || stored.type === 'anthropic' || stored.type === 'gemini' || stored.type === 'azure'
            ? stored.type
            : prev?.type || 'ollama';
        base[id] = {
          name: typeof stored.name === 'string' ? stored.name : prev?.name || id,
          type: resolvedType,
          host: typeof stored.host === 'string' ? stored.host : prev?.host || '',
          apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : prev?.apiKey || '',
          auth: stored.auth === 'api-key' || (stored.auth !== 'bearer' && resolvedType === 'azure') ? 'api-key' : 'bearer',
          enabled: typeof stored.enabled === 'boolean' ? stored.enabled : true,
        };
      }
    }
  } catch {
    // Corrupt file — quarantine it and rebuild from seeds
    try { fs.renameSync(STORE_FILE, STORE_FILE + '.bak'); } catch { /* ignore */ }
    base = seeded();
  }
  // At-rest migration: any plaintext key left in the file gets sealed before
  // the cache is populated, so providers.json never keeps secrets in clear.
  let mutated = false;
  for (const id of Object.keys(base)) {
    const p = base[id];
    if (p.apiKey && !isSealed(p.apiKey)) {
      p.apiKey = sealSecret(p.apiKey);
      mutated = true;
    }
  }
  cached = base;
  if (mutated) persist();
  return cached;
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0600 — the file holds sealed keys and host metadata; keep it owner-only.
  fs.writeFileSync(STORE_FILE, JSON.stringify(cached, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function throwStatus(status: number, message: string): never {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  throw err;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'provider';
}

export function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return 'â€¢â€¢â€¢â€¢';
  return 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + key.slice(-4);
}

/**
 * Guard against masked-key echo: the API only ever hands out maskKey() /
 * maskStored() output, so a client posting bullets back would silently
 * overwrite a real key. Reject bullet runs — pure (`â€¢â€¢â€¢â€¢`) and the exact
 * displayed shape (`â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢ab3d`) alike — instead of storing them.
 */
function assertNotMasked(apiKey: unknown): void {
  const key = String(apiKey ?? '');
  if (key && /^[\u2022\u00b7*]+[\w=-]{0,4}$/.test(key)) {
    throwStatus(400, 'Received a masked API key — send the real key or omit the field');
  }
}

/** Object-key safety: never let inherited properties (`__proto__`â€¦) pass as ids. */
function owns(cfg: Record<string, unknown>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(cfg, id);
}

/** Find an existing provider that already uses the same API key (or, when key is empty, the same host+type with no key). */
export function findDuplicateByKeyOrHost(apiKey: string, host?: string, type?: ProviderType): ProviderMeta | null {
  const cfg = load();
  const key = String(apiKey ?? '').trim();
  if (key) {
    const id = Object.keys(cfg).find((x) => openSecret(cfg[x].apiKey) === key);
    if (id) return listProviders().find((p) => p.id === id) || null;
  }
  if (host && type) {
    const h = normalizeHost(host);
    const id = Object.keys(cfg).find(
      (x) => !cfg[x].apiKey && !key && cfg[x].type === type && normalizeHost(cfg[x].host) === h
    );
    if (id) return listProviders().find((p) => p.id === id) || null;
  }
  return null;
}

/** All providers in insertion order (seeded defaults first). */
export function listProviders(): ProviderMeta[] {
  const cfg = load();
  return Object.entries(cfg).map(([id, p]) => ({
    id,
    name: p.name,
    type: p.type,
    host: p.host,
    apiKeyMasked: maskStored(p.apiKey),
    enabled: p.enabled,
  }));
}

export function getProviderMeta(id: string): ProviderMeta | null {
  return listProviders().find((p) => p.id === id) || null;
}

/**
 * Resolve a provider config by id.
 * A DISABLED provider is treated like a missing one — the admin turned it off,
 * so it must never be called with its stored key (paid spend on a provider the
 * operator stopped). Resolution falls back to the first ENABLED provider (the
 * same fallback all chat/agent surfaces already rely on after a provider
 * delete); 503 when NO provider is enabled at all.
 */
export function getProviderConfig(id: string): ProviderConfig {
  const cfg = load();
  if (owns(cfg, id) && cfg[id].enabled) return { ...cfg[id], apiKey: openSecret(cfg[id].apiKey) };
  const fallback = Object.values(cfg).find((p) => p.enabled);
  if (!fallback) throwStatus(503, 'No enabled providers available');
  return { ...fallback, apiKey: openSecret(fallback.apiKey) };
}

export function createProvider(input: {
  name: string;
  host: string;
  type?: ProviderType;
  apiKey?: string;
  enabled?: boolean;
  auth?: AuthMode;
}): ProviderMeta {
  const cfg = load();
  const name = String(input.name ?? '').trim();
  if (!name) throwStatus(400, 'Provider name is required');
  if (name.length > 80) throwStatus(400, 'Provider name is too long');
  const host = normalizeHost(String(input.host ?? ''));
  if (!host) throwStatus(400, 'Provider host / base URL is required');
  if (host.length > 500) throwStatus(400, 'Provider host is too long');

  const type: ProviderType =
    input.type === 'ollama' || input.type === 'anthropic' || input.type === 'gemini' || input.type === 'azure'
      ? input.type
      : 'openai';

  assertNotMasked(input.apiKey);

  let id = slugify(name);
  let n = 2;
  while (cfg[id]) id = `${slugify(name)}-${n++}`;

  cfg[id] = {
    name,
    type,
    host,
    apiKey: sealSecret(typeof input.apiKey === 'string' ? input.apiKey.trim() : ''),
    auth: type === 'azure' ? 'api-key' : input.auth === 'api-key' ? 'api-key' : 'bearer',
    enabled: input.enabled !== false,
  };
  persist();
  return listProviders().find((p) => p.id === id)!;
}

export function updateProvider(
  id: string,
  patch: { name?: string; host?: string; apiKey?: string; enabled?: boolean; type?: ProviderType; auth?: AuthMode }
): ProviderMeta {
  const cfg = load();
  if (!owns(cfg, id)) throwStatus(404, 'Unknown provider');
  const p = cfg[id];
  assertNotMasked(patch.apiKey);
  if (typeof patch.name === 'string') {
    const n = patch.name.trim();
    if (!n) throwStatus(400, 'Provider name cannot be empty');
    if (n.length > 80) throwStatus(400, 'Provider name is too long');
    p.name = n;
  }
  if (typeof patch.host === 'string') {
    const h = normalizeHost(patch.host);
    if (!h) throwStatus(400, 'Provider host cannot be empty');
    p.host = h.slice(0, 500);
  }
  if (typeof patch.apiKey === 'string') {
    p.apiKey = sealSecret(patch.apiKey.trim());
  }
  if (patch.type === 'ollama' || patch.type === 'openai' || patch.type === 'anthropic' || patch.type === 'gemini' || patch.type === 'azure') {
    p.type = patch.type;
  }
  // Azure always authenticates with the `api-key` header.
  if (patch.auth === 'api-key' || patch.auth === 'bearer') {
    p.auth = patch.auth;
  } else if (p.type === 'azure') {
    p.auth = 'api-key';
  }
  if (typeof patch.enabled === 'boolean') {
    p.enabled = patch.enabled;
  }
  persist();
  return listProviders().find((x) => x.id === id)!;
}

/** Invalidate the in-memory providers cache (call after external file writes). */
export function resetProviderCache(): void {
  cached = null;
}

export function deleteProvider(id: string): void {
  const cfg = load();
  if (!owns(cfg, id)) throwStatus(404, 'Unknown provider');
  if (Object.keys(cfg).length <= 1) {
    throwStatus(400, 'At least one provider must remain');
  }
  clearProviderRefs(id);
  delete cfg[id];
  persist();
}
