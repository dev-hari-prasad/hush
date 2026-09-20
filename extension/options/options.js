// extension/options/options.js
// Plain ES module for Hush options page

document.addEventListener('DOMContentLoaded', async () => {
  const optJevEndpoint = /** @type {HTMLInputElement} */ (document.getElementById('opt-jev-endpoint'));
  const optJevKey = /** @type {HTMLInputElement} */ (document.getElementById('opt-jev-key'));
  const optLlmBaseUrl = /** @type {HTMLInputElement} */ (document.getElementById('opt-llm-base-url'));
  const optLlmKey = /** @type {HTMLInputElement} */ (document.getElementById('opt-llm-key'));
  const optLlmModel = /** @type {HTMLInputElement} */ (document.getElementById('opt-llm-model'));
  const optNowThreshold = /** @type {HTMLInputElement} */ (document.getElementById('opt-now-threshold'));
  const optMuteThreshold = /** @type {HTMLInputElement} */ (document.getElementById('opt-mute-threshold'));
  const valNowThreshold = document.getElementById('val-now-threshold');
  const valMuteThreshold = document.getElementById('val-mute-threshold');
  const optSaveBtn = document.getElementById('opt-save-btn');

  optNowThreshold?.addEventListener('input', () => {
    if (valNowThreshold) valNowThreshold.textContent = optNowThreshold.value;
  });

  optMuteThreshold?.addEventListener('input', () => {
    if (valMuteThreshold) valMuteThreshold.textContent = optMuteThreshold.value;
  });

  const { worker_url, client_id } = await chrome.storage.local.get(['worker_url', 'client_id']);
  const activeUrl = worker_url || 'http://localhost:8787';

  // Load existing settings
  try {
    const res = await fetch(`${activeUrl}/v1/settings`, {
      headers: { 'X-Client-Id': client_id },
    });
    if (res.ok) {
      const s = await res.json();
      if (s.jev_endpoint) optJevEndpoint.value = s.jev_endpoint;
      if (s.jev_api_key) optJevKey.value = s.jev_api_key;
      if (s.llm_base_url) optLlmBaseUrl.value = s.llm_base_url;
      if (s.llm_api_key) optLlmKey.value = s.llm_api_key;
      if (s.llm_model) optLlmModel.value = s.llm_model;
      if (s.now_threshold) {
        optNowThreshold.value = String(s.now_threshold);
        if (valNowThreshold) valNowThreshold.textContent = String(s.now_threshold);
      }
      if (s.mute_threshold) {
        optMuteThreshold.value = String(s.mute_threshold);
        if (valMuteThreshold) valMuteThreshold.textContent = String(s.mute_threshold);
      }
    }
  } catch (err) {
    console.warn('Could not load remote settings:', err);
  }

  optSaveBtn?.addEventListener('click', async () => {
    const payload = {
      jev_endpoint: optJevEndpoint.value.trim(),
      jev_api_key: optJevKey.value.trim(),
      llm_base_url: optLlmBaseUrl.value.trim(),
      llm_api_key: optLlmKey.value.trim(),
      llm_model: optLlmModel.value.trim(),
      now_threshold: parseFloat(optNowThreshold.value),
      mute_threshold: parseFloat(optMuteThreshold.value),
    };

    try {
      const res = await fetch(`${activeUrl}/v1/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': client_id,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        optSaveBtn.textContent = '✓ Preferences Saved';
        setTimeout(() => { optSaveBtn.textContent = 'Save Preferences'; }, 2000);
      } else {
        alert('Failed to save settings to worker.');
      }
    } catch {
      alert('Error connecting to worker.');
    }
  });
});
