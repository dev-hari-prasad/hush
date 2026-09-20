// extension/scripts/background.js
// Chrome Manifest V3 Service Worker (ephemeral, state persisted in chrome.storage.local)

const DEFAULT_WORKER_URL = 'http://localhost:8787';

/**
 * Ensures client_id and initial storage configuration exists
 */
async function ensureConfig() {
  const data = await chrome.storage.local.get(['client_id', 'worker_url', 'offline_queue', 'allowed_sites']);
  const updates = {};

  if (!data.client_id) {
    updates.client_id = crypto.randomUUID();
  }
  if (!data.worker_url) {
    updates.worker_url = DEFAULT_WORKER_URL;
  }
  if (!Array.isArray(data.offline_queue)) {
    updates.offline_queue = [];
  }
  if (!Array.isArray(data.allowed_sites)) {
    updates.allowed_sites = [];
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  return { ...data, ...updates };
}

/**
 * Updates action badge with count of open 'now' items
 */
async function updateBadge() {
  try {
    const config = await ensureConfig();
    const res = await fetch(`${config.worker_url}/v1/notifications?lane=now&status=open&limit=100`, {
      headers: { 'X-Client-Id': config.client_id },
    });

    if (res.ok) {
      const data = await res.json();
      const count = data.notifications?.length || 0;
      if (count > 0) {
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#f6821f' }); // Cloudflare orange
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    }
  } catch {
    // If worker unreachable, leave badge as-is or clear
  }
}

/**
 * Flushes queued offline notifications
 */
async function flushOfflineQueue() {
  const config = await ensureConfig();
  const queue = config.offline_queue || [];
  if (queue.length === 0) return;

  const remaining = [];
  for (const item of queue) {
    try {
      const res = await fetch(`${config.worker_url}/v1/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': config.client_id,
        },
        body: JSON.stringify(item),
      });
      if (!res.ok) {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }

  await chrome.storage.local.set({ offline_queue: remaining });
  await updateBadge();
}

/**
 * Synchronizes dynamic content scripts for allowlisted sites
 */
async function syncContentScripts() {
  try {
    const { allowed_sites } = await chrome.storage.local.get('allowed_sites');
    const sites = Array.isArray(allowed_sites) ? allowed_sites : [];

    // Clear previously registered scripts
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing && existing.length > 0) {
      const ids = existing.map((s) => s.id);
      await chrome.scripting.unregisterContentScripts({ ids });
    }

    if (sites.length === 0) return;

    const matches = sites.map((site) => {
      const domain = site.replace(/^https?:\/\//, '').split('/')[0];
      return `*://${domain}/*`;
    });

    await chrome.scripting.registerContentScripts([
      {
        id: 'hush-hook-main',
        matches,
        js: ['scripts/hook.js'],
        runAt: 'document_start',
        world: 'MAIN',
      },
      {
        id: 'hush-bridge-isolated',
        matches,
        js: ['scripts/bridge.js'],
        runAt: 'document_start',
        world: 'ISOLATED',
      },
    ]);

    console.log('[Hush SW] Successfully registered dynamic content scripts for:', matches);
  } catch (err) {
    console.warn('[Hush SW] Dynamic content script registration error:', err);
  }
}

// Service worker lifecycle events
chrome.runtime.onInstalled.addListener(async () => {
  await ensureConfig();
  await syncContentScripts();
  await updateBadge();

  // Setup periodic sync alarm (every 5 minutes)
  chrome.alarms.create('hush_sync', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hush_sync') {
    flushOfflineQueue();
    updateBadge();
  }
});

// Message listener for runtime calls
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NOTIF_INGEST') {
    (async () => {
      const config = await ensureConfig();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);

        const res = await fetch(`${config.worker_url}/v1/notifications`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Id': config.client_id,
          },
          body: JSON.stringify(message.payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.ok) {
          const decision = await res.json();
          updateBadge();
          sendResponse(decision);
          return;
        }

        // On server error, fail open and enqueue
        console.warn(`[Hush SW] Worker status ${res.status}. Failing open.`);
        const queue = config.offline_queue || [];
        queue.push(message.payload);
        await chrome.storage.local.set({ offline_queue: queue });
        sendResponse({ lane: 'now', fail_open: true, reason: `worker_status_${res.status}` });
      } catch (err) {
        // Network timeout / offline: fail open
        console.warn('[Hush SW] Worker fetch failed or timed out. Failing open and queuing for later triage.');
        const queue = config.offline_queue || [];
        queue.push(message.payload);
        await chrome.storage.local.set({ offline_queue: queue });
        sendResponse({ lane: 'now', fail_open: true, reason: 'network_fail_open' });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === 'SYNC_SITES') {
    syncContentScripts().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'REFRESH_BADGE') {
    updateBadge().then(() => sendResponse({ success: true }));
    return true;
  }
});
