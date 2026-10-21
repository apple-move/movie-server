import { q, one, run } from '../db.js';
import { createLocalProvider } from './local.js';
import { createR2Provider } from './r2.js';
import { createGoogleDriveProvider } from './gdrive.js';
import { createMegaProvider } from './mega.js';
import { createTelegramProvider } from './telegram.js';
import { config } from '../config.js';

/**
 * Storage provider registry.
 *
 * A "provider instance" is one concrete storage target: one R2 bucket, one
 * MEGA account, one Google Drive account, one local folder, one Telegram bot.
 * Instances are stored in the database so you can add, edit and remove them
 * from the Admin panel without touching .env.
 */

const FACTORIES = {
  local: createLocalProvider,
  r2: createR2Provider,
  gdrive: createGoogleDriveProvider,
  mega: createMegaProvider,
  telegram: createTelegramProvider,
};

/** Live provider objects, keyed by instance id. */
const live = new Map();

export const PROVIDER_TYPES = [
  { id: 'local', name: 'Local Disk', icon: 'server' },
  { id: 'r2', name: 'Cloudflare R2', icon: 'cloud' },
  { id: 'gdrive', name: 'Google Drive', icon: 'folder' },
  { id: 'mega', name: 'MEGA', icon: 'database' },
  { id: 'telegram', name: 'Telegram', icon: 'send' },
];

/** Fields each provider type needs, used to build the admin form. */
export const PROVIDER_FIELDS = {
  local: [
    { key: 'root', label: 'Folder path', type: 'text', required: true, placeholder: './data/library' },
  ],
  r2: [
    { key: 'accountId', label: 'Account ID', type: 'text', required: true },
    { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true },
    { key: 'bucket', label: 'Bucket name', type: 'text', required: true },
    { key: 'endpoint', label: 'Custom endpoint (optional)', type: 'text' },
  ],
  gdrive: [
    { key: 'serviceAccountEmail', label: 'Service account email', type: 'text' },
    { key: 'serviceAccountPrivateKey', label: 'Service account private key', type: 'textarea' },
    { key: 'clientId', label: 'OAuth client ID (alternative)', type: 'text' },
    { key: 'clientSecret', label: 'OAuth client secret (alternative)', type: 'password' },
    { key: 'refreshToken', label: 'OAuth refresh token (alternative)', type: 'text' },
    { key: 'folderId', label: 'Folder ID', type: 'text' },
  ],
  mega: [
    { key: 'email', label: 'MEGA email', type: 'text', required: true },
    { key: 'password', label: 'MEGA password', type: 'password', required: true },
    { key: 'rootFolder', label: 'Root folder (optional)', type: 'text' },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot token', type: 'password', required: true },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true },
  ],
};

/* ------------------------------------------------------------------ CRUD */

export function listInstanceRows() {
  return q('SELECT * FROM provider_instances ORDER BY is_default DESC, type, name');
}

export function getInstanceRow(id) {
  return one('SELECT * FROM provider_instances WHERE id = ?', id);
}

export function createInstance({ id, type, name, config, isDefault = false }) {
  if (!FACTORIES[type]) {
    const err = new Error(`Unknown provider type: ${type}`);
    err.status = 400;
    throw err;
  }
  const instanceId = slugify(id || name);
  if (!instanceId) {
    const err = new Error('A provider id is required');
    err.status = 400;
    throw err;
  }
  if (getInstanceRow(instanceId)) {
    const err = new Error(`A provider with id "${instanceId}" already exists`);
    err.status = 400;
    throw err;
  }
  if (isDefault) {
    run('UPDATE provider_instances SET is_default = 0');
  }
  run(
    'INSERT INTO provider_instances (id, type, name, config, enabled, is_default) VALUES (?,?,?,?,1,?)',
    instanceId,
    type,
    name || instanceId,
    JSON.stringify(config || {}),
    isDefault ? 1 : 0,
  );
  return redactInstance(getInstanceRow(instanceId));
}

/**
 * Update an instance.
 *
 * The config is MERGED, never replaced: a blank field keeps the stored
 * secret, so editing a provider's name can never wipe its credentials.
 */
export async function updateInstance(id, { name, config, enabled, isDefault }) {
  const row = getInstanceRow(id);
  if (!row) {
    const err = new Error('Provider not found');
    err.status = 404;
    throw err;
  }
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push('name = ?');
    params.push(name);
  }
  if (config !== undefined) {
    const current = parseConfig(row.config);
    const merged = { ...current };
    for (const [key, value] of Object.entries(config || {})) {
      // An empty value means "leave it alone", not "erase it".
      if (value === '' || value === null || value === undefined) continue;
      merged[key] = value;
    }
    fields.push('config = ?');
    params.push(JSON.stringify(merged));
  }
  if (enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(enabled ? 1 : 0);
  }
  if (isDefault !== undefined) {
    if (isDefault) run('UPDATE provider_instances SET is_default = 0');
    fields.push('is_default = ?');
    params.push(isDefault ? 1 : 0);
  }
  if (fields.length) {
    params.push(id);
    run(`UPDATE provider_instances SET ${fields.join(', ')} WHERE id = ?`, ...params);
  }
  // Re-create the live provider so the new settings take effect.
  await reloadInstance(id);
  return redactInstance(getInstanceRow(id));
}

export async function deleteInstance(id) {
  const row = getInstanceRow(id);
  if (!row) {
    const err = new Error('Provider not found');
    err.status = 404;
    throw err;
  }
  run('DELETE FROM provider_instances WHERE id = ?', id);
  live.delete(id);
  return true;
}

function parseConfig(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

/**
 * Strip the credentials out of a row before it is sent to the browser.
 */
export function redactInstance(row) {
  if (!row) return row;
  const { config, ...rest } = row;
  return { ...rest, config: '{}', hasConfig: Object.keys(parseConfig(config)).length > 0 };
}

/* ------------------------------------------------------------- lifecycle */

export function buildProvider(row) {
  const factory = FACTORIES[row.type];
  if (!factory) return null;
  const parsed = parseConfig(row.config);
  return factory({
    id: row.id,
    name: row.name,
    description: row.description,
    config: parsed,
    ...(row.type === 'local' ? { root: parsed.root || config.libraryRoot } : {}),
  });
}

/**
 * Rebuild a provider and initialise it.
 *
 * `init()` is essential: it creates the R2 S3 client and logs into MEGA.
 * A provider that was never initialised would silently fail every request.
 */
export async function reloadInstance(id) {
  const row = getInstanceRow(id);
  if (!row) return null;
  if (!row.enabled) {
    live.delete(id);
    return null;
  }
  const provider = buildProvider(row);
  if (!provider) return null;
  try {
    await provider.init();
  } catch (err) {
    console.error(`[storage] failed to initialise provider "${id}":`, err.message);
    live.delete(id);
    return null;
  }
  live.set(id, provider);
  return provider;
}

export function getProvider(id) {
  const provider = live.get(id);
  if (provider) return provider;

  // Fall back to a lazily-built provider (e.g. a row added before a restart).
  const row = getInstanceRow(id);
  if (row) {
    if (!row.enabled) {
      const err = new Error(`Storage provider "${id}" is disabled`);
      err.status = 400;
      throw err;
    }
    const built = buildProvider(row);
    if (built) {
      // Note: init() is async, so a lazily-built provider is not connected.
      // The admin should restart or save the provider to initialise it.
      live.set(id, built);
      return built;
    }
  }
  const err = new Error(`Unknown storage provider: ${id}`);
  err.status = 400;
  throw err;
}

export function hasProvider(id) {
  return live.has(id) || Boolean(getInstanceRow(id));
}

/** Public listing for the admin panel (never exposes secrets). */
export function listProviders() {
  return listInstanceRows().map((row) => {
    const provider = live.get(row.id);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      description: provider?.description || '',
      icon: provider?.icon || PROVIDER_TYPES.find((t) => t.id === row.type)?.icon || 'server',
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      configured: provider ? provider.isConfigured() : false,
    };
  });
}

export function configuredProviders() {
  return listProviders().filter((p) => p.enabled && p.configured);
}

/* ------------------------------------------------------------- seeding */

/**
 * Create the default instances from .env if they do not exist yet.
 * Admin-added instances are never touched by this.
 */
export function seedInstancesFromEnv() {
  const seeds = [
    {
      id: 'local',
      type: 'local',
      name: 'Local Disk',
      config: { root: config.libraryRoot },
      isDefault: true,
    },
    {
      id: 'r2',
      type: 'r2',
      name: 'Cloudflare R2',
      config: {
        accountId: config.r2.accountId,
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
        bucket: config.r2.bucket,
        endpoint: config.r2.endpoint,
      },
    },
    {
      id: 'gdrive',
      type: 'gdrive',
      name: 'Google Drive',
      config: {
        serviceAccountEmail: config.google.serviceAccountEmail,
        serviceAccountPrivateKey: config.google.serviceAccountPrivateKey,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        refreshToken: config.google.refreshToken,
        folderId: config.google.folderId,
      },
    },
    {
      id: 'mega',
      type: 'mega',
      name: 'MEGA',
      config: {
        email: config.mega.email,
        password: config.mega.password,
        rootFolder: config.mega.rootFolder,
      },
    },
    {
      id: 'telegram',
      type: 'telegram',
      name: 'Telegram',
      config: {
        botToken: config.telegram.botToken,
        chatId: config.telegram.chatId,
      },
    },
  ];

  for (const seed of seeds) {
    const existing = getInstanceRow(seed.id);
    if (existing) {
      // Refresh the env-seeded instance so rotating a key in .env takes
      // effect on the next restart. Values that were blank in .env never
      // overwrite something an admin entered by hand.
      const current = parseConfig(existing.config);
      const merged = { ...current };
      let changed = false;
      for (const [key, value] of Object.entries(seed.config)) {
        if (!value) continue;
        if (merged[key] !== value) {
          merged[key] = value;
          changed = true;
        }
      }
      if (changed) {
        run('UPDATE provider_instances SET config = ? WHERE id = ?', JSON.stringify(merged), seed.id);
        console.log(`[storage] refreshed "${seed.id}" from .env`);
      }
      continue;
    }
    // Every provider type gets a slot, even when it is not configured yet —
    // the admin panel can then fill in the details without touching .env.
    run(
      'INSERT INTO provider_instances (id, type, name, config, enabled, is_default) VALUES (?,?,?,?,1,?)',
      seed.id,
      seed.type,
      seed.name,
      JSON.stringify(seed.config),
      seed.isDefault ? 1 : 0,
    );
  }
}

/** Initialise every enabled instance. */
export async function initProviders() {
  seedInstancesFromEnv();

  for (const row of listInstanceRows()) {
    if (!row.enabled) {
      console.log(`[storage] ${row.name}: disabled (skipped)`);
      continue;
    }
    const provider = buildProvider(row);
    if (!provider) continue;
    if (!provider.isConfigured()) {
      console.log(`[storage] ${row.name}: not configured (skipped)`);
      continue;
    }
    try {
      await provider.init();
      live.set(row.id, provider);
      console.log(`[storage] ${row.name}: ready`);
    } catch (err) {
      console.error(`[storage] ${row.name}: failed to initialise — ${err.message}`);
    }
  }
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}
