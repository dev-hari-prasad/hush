// extension/scripts/hook.js
// Runs in MAIN world at document_start.
// Monkey-patches window.Notification with complete fidelity and fail-open semantics.

(() => {
  if (window.__HUSH_HOOK_INSTALLED__) return;
  window.__HUSH_HOOK_INSTALLED__ = true;

  const RealNotification = window.Notification;
  if (!RealNotification) return;

  /**
   * Stand-in Notification constructor that mimics RealNotification
   * @param {string} title
   * @param {NotificationOptions} [options]
   */
  function HushNotification(title, options = {}) {
    const id = 'notif_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
    let realInstance = null;
    let isSuppressed = false;
    let resolved = false;

    // Stand-in event handlers
    const listeners = {
      click: [],
      close: [],
      show: [],
      error: [],
    };

    const instance = this;

    instance.title = String(title);
    instance.dir = options.dir || 'auto';
    instance.lang = options.lang || '';
    instance.body = options.body || '';
    instance.tag = options.tag || '';
    instance.icon = options.icon || '';
    instance.badge = options.badge || '';
    instance.silent = Boolean(options.silent);
    instance.timestamp = options.timestamp || Date.now();
    instance.data = options.data || null;

    instance.onclick = null;
    instance.onclose = null;
    instance.onshow = null;
    instance.onerror = null;

    instance.addEventListener = function (type, callback) {
      if (listeners[type]) listeners[type].push(callback);
    };

    instance.removeEventListener = function (type, callback) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((cb) => cb !== callback);
      }
    };

    instance.dispatchEvent = function (event) {
      const type = event.type;
      const handler = instance['on' + type];
      if (typeof handler === 'function') {
        try { handler.call(instance, event); } catch (e) { console.error(e); }
      }
      if (listeners[type]) {
        for (const cb of listeners[type]) {
          try { cb.call(instance, event); } catch (e) { console.error(e); }
        }
      }
      return true;
    };

    instance.close = function () {
      if (realInstance && typeof realInstance.close === 'function') {
        realInstance.close();
      }
      instance.dispatchEvent(new Event('close'));
    };

    function showRealNotification() {
      if (resolved) return;
      resolved = true;
      try {
        realInstance = new RealNotification(title, options);
        realInstance.onclick = (e) => instance.dispatchEvent(new Event('click', e));
        realInstance.onclose = (e) => instance.dispatchEvent(new Event('close', e));
        realInstance.onshow = (e) => instance.dispatchEvent(new Event('show', e));
        realInstance.onerror = (e) => instance.dispatchEvent(new Event('error', e));
      } catch (err) {
        console.warn('[Hush Hook] Failed to create native notification:', err);
        instance.dispatchEvent(new Event('error'));
      }
    }

    function suppressNotification(reason) {
      if (resolved) return;
      resolved = true;
      isSuppressed = true;
      // Fire simulated 'show' so callers awaiting appearance do not hang
      setTimeout(() => {
        instance.dispatchEvent(new Event('show'));
      }, 50);
    }

    // Fail-open safety timer: if no triage decision returns within 1500ms, display original notification
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        console.log('[Hush Hook] Triage timeout (~1500ms). Failing open to show notification.');
        showRealNotification();
      }
    }, 1500);

    // Listen for decision event from the isolated bridge
    const decisionEventName = `__HUSH_NOTIF_DECISION__${id}`;
    function onDecision(event) {
      clearTimeout(timeoutId);
      window.removeEventListener(decisionEventName, onDecision);

      const decision = event.detail || {};
      if (decision.lane === 'now' || decision.fail_open) {
        showRealNotification();
      } else {
        suppressNotification(decision.lane || 'muted');
      }
    }

    window.addEventListener(decisionEventName, onDecision);

    // Dispatch capture event to isolated-world bridge
    const interceptEvent = new CustomEvent('__HUSH_NOTIF_INTERCEPT__', {
      detail: {
        id,
        title: String(title),
        body: options.body ? String(options.body) : '',
        icon: options.icon ? String(options.icon) : '',
        tag: options.tag ? String(options.tag) : '',
        domain: window.location.hostname,
        received_at: new Date().toISOString(),
      },
    });
    window.dispatchEvent(interceptEvent);

    return instance;
  }

  // Preserve constructor prototype chain & instanceof checks
  HushNotification.prototype = Object.create(RealNotification.prototype);
  HushNotification.prototype.constructor = HushNotification;

  // Preserve static properties and methods
  Object.defineProperty(HushNotification, 'permission', {
    get: () => RealNotification.permission,
    enumerable: true,
  });

  HushNotification.requestPermission = function (callback) {
    return RealNotification.requestPermission(callback);
  };

  if ('maxActions' in RealNotification) {
    HushNotification.maxActions = RealNotification.maxActions;
  }

  // Replace window.Notification
  window.Notification = HushNotification;
  console.log('[Hush Hook] Successfully installed notification interception hook.');
})();
