// extension/popup/popup.js
// Plain JavaScript ES module with JSDoc types (no bundler)
// Follows AGENTS.md: safe DOM manipulation using textContent, never innerHTML.

/**
 * @typedef {Object} NotificationItem
 * @property {string} id
 * @property {string} source_domain
 * @property {string|null} sender
 * @property {string} title
 * @property {string|null} body
 * @property {string} lane
 * @property {string} lane_reason
 * @property {number} urgency
 * @property {number} [confidence]
 * @property {boolean} [suspicious]
 * @property {string} received_at
 * @property {string} status
 */

let currentWorkerUrl = 'http://localhost:8787';
let currentClientId = '';

// DOM Elements
const connectionStatus = /** @type {HTMLElement} */ (document.getElementById('connection-status'));
const tabs = document.querySelectorAll('.tab-btn');
const panes = document.querySelectorAll('.tab-pane');
const badgeNow = document.getElementById('badge-now');
const badgeLater = document.getElementById('badge-later');
const badgeMute = document.getElementById('badge-mute');

const listNow = document.getElementById('list-now');
const listLater = document.getElementById('list-later');
const listMute = document.getElementById('list-mute');

const btnQuickSim = document.getElementById('btn-quick-sim');
const btnOpenOptions = document.getElementById('btn-open-options');
const chatForm = document.getElementById('chat-form');
const chatInput = /** @type {HTMLInputElement} */ (document.getElementById('chat-input'));
const chatHistory = document.getElementById('chat-history');
const btnRunDigest = document.getElementById('btn-run-digest');
const digestContent = document.getElementById('digest-content');

// Settings Elements
const cfgWorkerUrl = /** @type {HTMLInputElement} */ (document.getElementById('cfg-worker-url'));
const cfgClientId = /** @type {HTMLInputElement} */ (document.getElementById('cfg-client-id'));
const btnCopyClientId = document.getElementById('btn-copy-client-id');
const cfgJevEndpoint = /** @type {HTMLInputElement} */ (document.getElementById('cfg-jev-endpoint'));
const cfgJevKey = /** @type {HTMLInputElement} */ (document.getElementById('cfg-jev-key'));
const cfgLlmBaseUrl = /** @type {HTMLInputElement} */ (document.getElementById('cfg-llm-base-url'));
const cfgLlmKey = /** @type {HTMLInputElement} */ (document.getElementById('cfg-llm-key'));
const cfgLlmModel = /** @type {HTMLInputElement} */ (document.getElementById('cfg-llm-model'));
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnWipeData = document.getElementById('btn-wipe-data');
const inputNewSite = /** @type {HTMLInputElement} */ (document.getElementById('input-new-site'));
const btnAddSite = document.getElementById('btn-add-site');
const allowedSitesList = document.getElementById('allowed-sites-list');

/**
 * Initialize Popup Configuration
 */
async function init() {
  const config = await chrome.storage.local.get(['worker_url', 'client_id', 'allowed_sites']);
  currentWorkerUrl = config.worker_url || 'http://localhost:8787';

  if (!config.client_id) {
    currentClientId = crypto.randomUUID();
    await chrome.storage.local.set({ client_id: currentClientId });
  } else {
    currentClientId = config.client_id;
  }

  cfgWorkerUrl.value = currentWorkerUrl;
  cfgClientId.value = currentClientId;

  setupNavigation();
  setupSettingsHandlers();
  setupChat();
  setupDigest();
  renderAllowedSites(config.allowed_sites || []);

  await checkWorkerHealth();
  await loadNotifications();
  await loadRemoteSettings();
}

/**
 * Tab Navigation Setup
 */
function setupNavigation() {
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabs.forEach((t) => t.classList.remove('active'));
      panes.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(`pane-${targetTab}`);
      if (targetPane) targetPane.classList.add('active');

      if (targetTab === 'digest') loadLatestDigest();
      else if (['now', 'later', 'mute'].includes(targetTab || '')) loadNotifications();
    });
  });

  btnOpenOptions?.addEventListener('click', () => {
    tabs.forEach((t) => {
      if (t.getAttribute('data-tab') === 'settings') t.click();
    });
  });

  btnQuickSim?.addEventListener('click', async () => {
    btnQuickSim.setAttribute('disabled', 'true');
    try {
      await fetch(`${currentWorkerUrl}/v1/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': currentClientId,
        },
        body: JSON.stringify({ scenario: 'workday', count: 5 }),
      });
      await loadNotifications();
    } catch (err) {
      console.warn('Simulation failed:', err);
    } finally {
      btnQuickSim.removeAttribute('disabled');
    }
  });
}

/**
 * Health check on Cloudflare Worker
 */
async function checkWorkerHealth() {
  try {
    const res = await fetch(`${currentWorkerUrl}/health`);
    if (res.ok) {
      connectionStatus.classList.remove('offline');
      connectionStatus.title = 'Worker: Online and triaging';
    } else {
      connectionStatus.classList.add('offline');
      connectionStatus.title = `Worker Error (${res.status})`;
    }
  } catch {
    connectionStatus.classList.add('offline');
    connectionStatus.title = 'Worker: Unreachable (Offline)';
  }
}

/**
 * Fetch and Render Notifications for all lanes
 */
async function loadNotifications() {
  try {
    const [resNow, resLater, resMute] = await Promise.all([
      fetch(`${currentWorkerUrl}/v1/notifications?lane=now&status=open&limit=50`, { headers: { 'X-Client-Id': currentClientId } }),
      fetch(`${currentWorkerUrl}/v1/notifications?lane=later&status=open&limit=50`, { headers: { 'X-Client-Id': currentClientId } }),
      fetch(`${currentWorkerUrl}/v1/notifications?lane=mute&status=open&limit=50`, { headers: { 'X-Client-Id': currentClientId } }),
    ]);

    const dataNow = resNow.ok ? await resNow.json() : { notifications: [] };
    const dataLater = resLater.ok ? await resLater.json() : { notifications: [] };
    const dataMute = resMute.ok ? await resMute.json() : { notifications: [] };

    if (badgeNow) badgeNow.textContent = String(dataNow.notifications.length);
    if (badgeLater) badgeLater.textContent = String(dataLater.notifications.length);
    if (badgeMute) badgeMute.textContent = String(dataMute.notifications.length);

    renderList(listNow, dataNow.notifications, 'now');
    renderList(listLater, dataLater.notifications, 'later');
    renderList(listMute, dataMute.notifications, 'mute');
  } catch (err) {
    console.warn('Failed to load notifications:', err);
  }
}

/**
 * Render Notification List Safely (No innerHTML for untrusted content)
 * @param {HTMLElement|null} container
 * @param {NotificationItem[]} items
 * @param {'now'|'later'|'mute'} lane
 */
function renderList(container, items, lane) {
  if (!container) return;
  container.textContent = ''; // Safe clear

  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';

    const p = document.createElement('p');
    p.textContent = lane === 'now' ? 'All caught up! No urgent interruptions.' : 'No notifications in this lane.';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = `notif-card lane-${lane}`;
    if (item.suspicious) card.classList.add('is-suspicious');

    // Card Top
    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';

    const sourceInfo = document.createElement('div');
    sourceInfo.className = 'card-source-info';

    const domainSpan = document.createElement('span');
    domainSpan.className = 'source-domain';
    domainSpan.textContent = item.source_domain;
    sourceInfo.appendChild(domainSpan);

    if (item.sender) {
      const senderSpan = document.createElement('span');
      senderSpan.className = 'source-sender';
      senderSpan.textContent = `@${item.sender}`;
      sourceInfo.appendChild(senderSpan);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'card-time';
    timeSpan.textContent = formatRelativeTime(item.received_at);

    cardTop.appendChild(sourceInfo);
    cardTop.appendChild(timeSpan);
    card.appendChild(cardTop);

    // Title (Strict textContent)
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = item.title;
    card.appendChild(titleEl);

    // Body (Strict textContent)
    if (item.body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      bodyEl.textContent = item.body;
      card.appendChild(bodyEl);
    }

    // Signals & Reason Chips
    const signalsEl = document.createElement('div');
    signalsEl.className = 'card-signals';

    if (item.lane_reason) {
      const reasonChip = document.createElement('span');
      reasonChip.className = 'chip chip-reason';
      reasonChip.textContent = cleanReason(item.lane_reason);
      signalsEl.appendChild(reasonChip);
    }

    if (item.urgency) {
      const urgencyChip = document.createElement('span');
      urgencyChip.className = 'chip chip-urgency';
      urgencyChip.textContent = `Urgency ${item.urgency}/5`;
      signalsEl.appendChild(urgencyChip);
    }

    if (item.suspicious) {
      const suspChip = document.createElement('span');
      suspChip.className = 'chip chip-suspicious';
      suspChip.textContent = '⚠ Suspicious / Quarantined';
      signalsEl.appendChild(suspChip);
    }

    card.appendChild(signalsEl);

    // Actions Toolbar
    const actionsEl = document.createElement('div');
    actionsEl.className = 'card-actions';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'btn-group';

    // Done Button
    const btnDone = document.createElement('button');
    btnDone.className = 'btn-action';
    btnDone.textContent = '✓ Done';
    btnDone.addEventListener('click', () => performAction(item.id, 'done'));
    leftGroup.appendChild(btnDone);

    // Snooze Button
    const btnSnooze = document.createElement('button');
    btnSnooze.className = 'btn-action';
    btnSnooze.textContent = '⏱ Snooze';
    btnSnooze.addEventListener('click', () => {
      const until = new Date(Date.now() + 3600 * 1000).toISOString();
      performAction(item.id, 'snooze', { until });
    });
    leftGroup.appendChild(btnSnooze);

    // Move Button
    const btnMove = document.createElement('button');
    btnMove.className = 'btn-action';
    const nextLane = lane === 'now' ? 'later' : 'now';
    btnMove.textContent = `⇄ Move to ${nextLane}`;
    btnMove.addEventListener('click', () => performAction(item.id, 'move', { lane: nextLane }));
    leftGroup.appendChild(btnMove);

    actionsEl.appendChild(leftGroup);

    const rightGroup = document.createElement('div');
    rightGroup.className = 'btn-group';

    // Draft Reply Button
    const btnDraft = document.createElement('button');
    btnDraft.className = 'btn-action';
    btnDraft.textContent = '💬 Draft';
    btnDraft.addEventListener('click', () => toggleDraftPanel(card, item));
    rightGroup.appendChild(btnDraft);

    actionsEl.appendChild(rightGroup);
    card.appendChild(actionsEl);

    container.appendChild(card);
  });
}

/**
 * Action Handler (done, snooze, move, mute_source)
 */
async function performAction(id, action, params = {}) {
  try {
    const res = await fetch(`${currentWorkerUrl}/v1/notifications/${id}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': currentClientId,
      },
      body: JSON.stringify({ action, ...params }),
    });

    if (res.ok) {
      await loadNotifications();
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
    }
  } catch (err) {
    console.warn('Action failed:', err);
  }
}

/**
 * Toggle Inline Draft Reply Panel
 */
function toggleDraftPanel(card, item) {
  let draftPanel = card.querySelector('.draft-panel');
  if (draftPanel) {
    draftPanel.remove();
    return;
  }

  draftPanel = document.createElement('div');
  draftPanel.className = 'draft-panel open';

  const toneBar = document.createElement('div');
  toneBar.className = 'tone-selector';

  ['brief', 'friendly', 'formal'].forEach((tone, idx) => {
    const pill = document.createElement('button');
    pill.className = `tone-pill ${idx === 0 ? 'active' : ''}`;
    pill.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
    pill.addEventListener('click', () => {
      toneBar.querySelectorAll('.tone-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      fetchDraft(item.id, tone, textContainer, copyBtn);
    });
    toneBar.appendChild(pill);
  });

  draftPanel.appendChild(toneBar);

  const textContainer = document.createElement('div');
  textContainer.className = 'draft-text';
  textContainer.textContent = 'Generating draft with AI...';
  draftPanel.appendChild(textContainer);

  const bottomBar = document.createElement('div');
  bottomBar.style.display = 'flex';
  bottomBar.style.justifyContent = 'flex-end';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-action btn-primary';
  copyBtn.textContent = '📋 Copy Draft';
  copyBtn.style.display = 'none';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(textContainer.textContent || '');
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = '📋 Copy Draft'; }, 1500);
  });

  bottomBar.appendChild(copyBtn);
  draftPanel.appendChild(bottomBar);

  card.appendChild(draftPanel);
  fetchDraft(item.id, 'brief', textContainer, copyBtn);
}

/**
 * Fetch Draft from Worker
 */
async function fetchDraft(id, tone, container, copyBtn) {
  container.textContent = 'Generating draft with AI...';
  copyBtn.style.display = 'none';
  try {
    const res = await fetch(`${currentWorkerUrl}/v1/notifications/${id}/draft-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': currentClientId,
      },
      body: JSON.stringify({ tone }),
    });

    if (res.ok) {
      const draft = await res.json();
      container.textContent = draft.text;
      copyBtn.style.display = 'inline-flex';
    } else {
      container.textContent = 'Failed to generate draft.';
    }
  } catch {
    container.textContent = 'Network error generating draft.';
  }
}

/**
 * Conversational Assistant Setup
 */
function setupChat() {
  chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = chatInput.value.trim();
    if (!query) return;

    chatInput.value = '';

    // Add user bubble
    const userBubble = document.createElement('div');
    userBubble.className = 'chat-bubble user';
    userBubble.textContent = query;
    chatHistory.appendChild(userBubble);

    // Add loading bubble
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'chat-bubble assistant';
    assistantBubble.textContent = 'Analyzing notifications...';
    chatHistory.appendChild(assistantBubble);
    chatHistory.scrollTop = chatHistory.scrollHeight;

    try {
      const res = await fetch(`${currentWorkerUrl}/v1/notifications/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': currentClientId,
        },
        body: JSON.stringify({ query }),
      });

      if (res.ok) {
        const data = await res.json();
        assistantBubble.textContent = data.answer;
      } else {
        assistantBubble.textContent = 'Sorry, could not analyze notifications right now.';
      }
    } catch {
      assistantBubble.textContent = 'Connection error reaching Hush assistant.';
    }
    chatHistory.scrollTop = chatHistory.scrollHeight;
  });
}

/**
 * Digest Setup & Retrieval
 */
function setupDigest() {
  btnRunDigest?.addEventListener('click', async () => {
    btnRunDigest.setAttribute('disabled', 'true');
    btnRunDigest.textContent = 'Generating...';
    try {
      const res = await fetch(`${currentWorkerUrl}/v1/digest/run`, {
        method: 'POST',
        headers: { 'X-Client-Id': currentClientId },
      });
      if (res.ok) {
        await loadLatestDigest();
      }
    } finally {
      btnRunDigest.removeAttribute('disabled');
      btnRunDigest.textContent = '⚡ Generate';
    }
  });
}

async function loadLatestDigest() {
  if (!digestContent) return;
  digestContent.textContent = 'Loading latest digest...';

  try {
    const res = await fetch(`${currentWorkerUrl}/v1/digest/latest`, {
      headers: { 'X-Client-Id': currentClientId },
    });

    if (res.ok) {
      const data = await res.json();
      if (!data.digest || !data.digest.summary_json) {
        digestContent.textContent = 'No digests generated yet. Click "Generate" to create one.';
        return;
      }

      const summary = JSON.parse(data.digest.summary_json);
      digestContent.textContent = ''; // Safe clear

      const pSummary = document.createElement('p');
      pSummary.style.color = '#ffffff';
      pSummary.style.fontWeight = '500';
      pSummary.style.marginBottom = '10px';
      pSummary.textContent = summary.summary;
      digestContent.appendChild(pSummary);

      if (summary.top_items && summary.top_items.length > 0) {
        const topHeader = document.createElement('h5');
        topHeader.style.color = 'var(--accent-orange)';
        topHeader.style.fontSize = '12px';
        topHeader.style.margin = '8px 0 4px';
        topHeader.textContent = '🔥 Top Items To Review:';
        digestContent.appendChild(topHeader);

        summary.top_items.forEach((item) => {
          const itemDiv = document.createElement('div');
          itemDiv.style.fontSize = '11px';
          itemDiv.style.padding = '4px 0';
          itemDiv.textContent = `• ${item.title} (${item.reason || ''})`;
          digestContent.appendChild(itemDiv);
        });
      }

      if (summary.groups && summary.groups.length > 0) {
        summary.groups.forEach((g) => {
          const gDiv = document.createElement('div');
          gDiv.className = 'digest-group';

          const gTitle = document.createElement('div');
          gTitle.style.fontWeight = '600';
          gTitle.style.color = 'var(--accent-blue)';
          gTitle.textContent = `${g.source_domain} (${g.item_count} updates)`;

          const gText = document.createElement('div');
          gText.style.color = 'var(--text-muted)';
          gText.style.fontSize = '11px';
          gText.textContent = g.summary;

          gDiv.appendChild(gTitle);
          gDiv.appendChild(gText);
          digestContent.appendChild(gDiv);
        });
      }
    }
  } catch (err) {
    digestContent.textContent = 'Failed to load digest.';
  }
}

/**
 * Settings & BYOK Setup
 */
async function loadRemoteSettings() {
  try {
    const res = await fetch(`${currentWorkerUrl}/v1/settings`, {
      headers: { 'X-Client-Id': currentClientId },
    });
    if (res.ok) {
      const s = await res.json();
      if (s.jev_endpoint) cfgJevEndpoint.value = s.jev_endpoint;
      if (s.jev_api_key) cfgJevKey.value = s.jev_api_key;
      if (s.llm_base_url) cfgLlmBaseUrl.value = s.llm_base_url;
      if (s.llm_api_key) cfgLlmKey.value = s.llm_api_key;
      if (s.llm_model) cfgLlmModel.value = s.llm_model;
    }
  } catch (err) {
    console.warn('Could not fetch remote settings:', err);
  }
}

function setupSettingsHandlers() {
  btnCopyClientId?.addEventListener('click', () => {
    navigator.clipboard.writeText(currentClientId);
    btnCopyClientId.textContent = 'Copied!';
    setTimeout(() => { btnCopyClientId.textContent = 'Copy'; }, 1500);
  });

  btnSaveSettings?.addEventListener('click', async () => {
    currentWorkerUrl = cfgWorkerUrl.value.trim() || 'http://localhost:8787';
    await chrome.storage.local.set({ worker_url: currentWorkerUrl });

    const payload = {
      jev_endpoint: cfgJevEndpoint.value.trim(),
      jev_api_key: cfgJevKey.value.trim(),
      llm_base_url: cfgLlmBaseUrl.value.trim(),
      llm_api_key: cfgLlmKey.value.trim(),
      llm_model: cfgLlmModel.value.trim(),
    };

    try {
      const res = await fetch(`${currentWorkerUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': currentClientId,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        btnSaveSettings.textContent = '✓ Saved Successfully!';
        setTimeout(() => { btnSaveSettings.textContent = 'Save Settings'; }, 2000);
      }
    } catch {
      alert('Error updating remote worker settings.');
    }
  });

  btnAddSite?.addEventListener('click', async () => {
    const raw = inputNewSite.value.trim();
    if (!raw) return;
    const domain = raw.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

    // Request Chrome optional host permission
    try {
      const granted = await chrome.permissions.request({
        origins: [`https://${domain}/*`, `http://${domain}/*`],
      });

      if (!granted) {
        alert(`Permission to intercept notifications on ${domain} was declined.`);
        return;
      }

      const { allowed_sites } = await chrome.storage.local.get('allowed_sites');
      const sites = Array.isArray(allowed_sites) ? allowed_sites : [];
      if (!sites.includes(domain)) {
        sites.push(domain);
        await chrome.storage.local.set({ allowed_sites: sites });
        renderAllowedSites(sites);
        chrome.runtime.sendMessage({ type: 'SYNC_SITES' });
      }
      inputNewSite.value = '';
    } catch (err) {
      console.warn('Permission request error:', err);
    }
  });

  btnWipeData?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to delete all triaged notifications and rules? This cannot be undone.')) return;
    try {
      await fetch(`${currentWorkerUrl}/v1/data`, {
        method: 'DELETE',
        headers: { 'X-Client-Id': currentClientId },
      });
      await loadNotifications();
      alert('All client data wiped from worker database.');
    } catch {
      alert('Error communicating with worker to wipe data.');
    }
  });
}

function renderAllowedSites(sites) {
  if (!allowedSitesList) return;
  allowedSitesList.textContent = '';

  if (sites.length === 0) {
    const span = document.createElement('span');
    span.style.color = 'var(--text-dim)';
    span.style.fontSize = '11px';
    span.textContent = 'No sites added yet. Add a site above to start capturing.';
    allowedSitesList.appendChild(span);
    return;
  }

  sites.forEach((site) => {
    const pill = document.createElement('span');
    pill.className = 'chip chip-reason';
    pill.style.display = 'inline-flex';
    pill.style.alignItems = 'center';
    pill.style.gap = '4px';

    const text = document.createElement('span');
    text.textContent = site;
    pill.appendChild(text);

    const removeBtn = document.createElement('span');
    removeBtn.textContent = '×';
    removeBtn.style.cursor = 'pointer';
    removeBtn.style.fontWeight = 'bold';
    removeBtn.addEventListener('click', async () => {
      const updated = sites.filter((s) => s !== site);
      await chrome.storage.local.set({ allowed_sites: updated });
      renderAllowedSites(updated);
      chrome.runtime.sendMessage({ type: 'SYNC_SITES' });
    });

    pill.appendChild(removeBtn);
    allowedSitesList.appendChild(pill);
  });
}

function cleanReason(reason) {
  if (!reason) return '';
  if (reason.startsWith('rule:')) return '⚡ User Rule Matched';
  if (reason.includes('otp')) return '🔑 Security OTP (Priority)';
  if (reason.includes('security')) return '🚨 Security Alert';
  if (reason.includes('calendar') || reason.includes('meeting')) return '📅 Imminent Meeting';
  if (reason.includes('promotional')) return '🏷 Promotional';
  if (reason.includes('direct_message')) return '💬 Direct Message';
  if (reason.includes('focus_mode')) return '🎯 Focus Mode Deferred';
  return reason.replace(/_/g, ' ');
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// Kick off initialization on DOM ready
document.addEventListener('DOMContentLoaded', init);
