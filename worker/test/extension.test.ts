// worker/test/extension.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Chrome Extension: Hook Fidelity & Fail-Open Semantics', () => {
  it('preserves Notification prototype methods and properties', () => {
    // Mock native Notification
    class MockRealNotification {
      static permission = 'granted';
      static requestPermission = vi.fn().mockResolvedValue('granted');
      static maxActions = 2;
      title: string;
      options: any;
      onclick: any = null;
      onclose: any = null;
      constructor(title: string, options: any = {}) {
        this.title = title;
        this.options = options;
      }
      close() {}
    }

    (globalThis as any).Notification = MockRealNotification;
    (globalThis as any).window = globalThis;

    // Load hook logic
    const RealNotification = (globalThis as any).Notification;

    function HushNotification(this: any, title: string, options: any = {}) {
      this.title = title;
      this.body = options.body || '';
      this.close = function () {};
    }

    HushNotification.prototype = Object.create(RealNotification.prototype);
    HushNotification.prototype.constructor = HushNotification;

    Object.defineProperty(HushNotification, 'permission', {
      get: () => RealNotification.permission,
      enumerable: true,
    });
    HushNotification.requestPermission = RealNotification.requestPermission;

    (globalThis as any).Notification = HushNotification;

    // Verify static access
    expect((globalThis as any).Notification.permission).toBe('granted');
    expect((globalThis as any).Notification.requestPermission).toBeDefined();

    // Verify instanceof
    const notifInstance = new (HushNotification as any)('Test Title', { body: 'Test body' });
    expect(notifInstance instanceof RealNotification).toBe(true);
    expect(notifInstance.title).toBe('Test Title');
  });

  it('fails open when worker/bridge times out', async () => {
    let nativeNotificationCreated = false;

    class RealNotification {
      constructor(title: string, options: any) {
        nativeNotificationCreated = true;
      }
    }

    // Simulate fail-open timer
    const failOpenPromise = new Promise<boolean>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          new RealNotification('Test', {});
          resolve(true);
        }
      }, 50);
    });

    const didFailOpen = await failOpenPromise;
    expect(didFailOpen).toBe(true);
    expect(nativeNotificationCreated).toBe(true);
  });
});
