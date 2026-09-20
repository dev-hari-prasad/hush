// extension/scripts/bridge.js
// Runs in ISOLATED world on allowlisted sites.
// Bridges window events from MAIN-world hook to Chrome extension background service worker.

(() => {
  // Inject MAIN-world hook script into DOM if needed
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('scripts/hook.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  } catch (err) {
    console.warn('[Hush Bridge] Hook injection note:', err);
  }

  // Client-side on-device PII redaction
  const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const LONG_DIGITS_REGEX = /\b\d{8,}\b/g;
  const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
  const URL_QUERY_REGEX = /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]+/gi;

  function redactOnDevice(text) {
    if (!text) return '';
    return text
      .replace(URL_QUERY_REGEX, '$1[URL_PARAMS]')
      .replace(EMAIL_REGEX, '[EMAIL]')
      .replace(LONG_DIGITS_REGEX, '[REDACTED_NUM]')
      .replace(PHONE_REGEX, '[PHONE]');
  }

  // Listen for notification capture events from MAIN world
  window.addEventListener('__HUSH_NOTIF_INTERCEPT__', async (event) => {
    const detail = event.detail;
    if (!detail || !detail.id) return;

    const id = detail.id;
    const sanitizedTitle = redactOnDevice(detail.title || '');
    const sanitizedBody = redactOnDevice(detail.body || '');

    const payload = {
      source: {
        domain: detail.domain || window.location.hostname,
      },
      title: sanitizedTitle,
      body: sanitizedBody,
      received_at: detail.received_at || new Date().toISOString(),
    };

    let decision = { lane: 'now', fail_open: true };

    try {
      // Send to background service worker
      decision = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ lane: 'now', fail_open: true, reason: 'extension_bridge_timeout' });
        }, 1200);

        chrome.runtime.sendMessage(
          { type: 'NOTIF_INGEST', payload },
          (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError || !response) {
              resolve({ lane: 'now', fail_open: true, reason: 'runtime_error' });
            } else {
              resolve(response);
            }
          }
        );
      });
    } catch (err) {
      console.warn('[Hush Bridge] Communication error, failing open:', err);
      decision = { lane: 'now', fail_open: true, reason: 'exception_fail_open' };
    }

    // Return decision to MAIN world hook
    const decisionEvent = new CustomEvent(`__HUSH_NOTIF_DECISION__${id}`, {
      detail: decision,
    });
    window.dispatchEvent(decisionEvent);
  });
})();
