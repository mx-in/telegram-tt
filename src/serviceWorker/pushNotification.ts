import { APP_NAME, DEBUG } from '../config';

declare const self: ServiceWorkerGlobalScope;

enum Boolean {
  True = '1',
  False = '0',
}

type PushData = {
  custom: {
    msg_id?: string;
    channel_id?: string;
    chat_id?: string;
    from_id?: string;
  };
  mute: Boolean;
  badge: Boolean;
  loc_key: string;
  loc_args: string[];
  random_id: number;
  title: string;
  description: string;
};

type NotificationData = {
  messageId?: number;
  chatId?: number;
  title: string;
  body: string;
  icon?: string;
};

let lastSyncAt = new Date().valueOf();
const shownNotifications = new Set();
const clickBuffer: Record<string, NotificationData> = {};

function getPushData(e: PushEvent | Notification): PushData | undefined {
  try {
    return e.data.json();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[SW] Unable to parse push notification data', e.data);
    }
    return undefined;
  }
}

function getChatId(data: PushData) {
  if (data.custom.from_id) {
    return parseInt(data.custom.from_id, 10);
  }
  // Chats and channels have negative IDs
  if (data.custom.chat_id) {
    return parseInt(data.custom.chat_id, 10) * -1;
  }
  if (data.custom.channel_id) {
    return parseInt(data.custom.channel_id, 10) * -1;
  }
  return undefined;
}

function getMessageId(data: PushData) {
  if (!data.custom.msg_id) return undefined;
  return parseInt(data.custom.msg_id, 10);
}

function getNotificationData(data: PushData): NotificationData {
  return {
    chatId: getChatId(data),
    messageId: getMessageId(data),
    title: data.title || APP_NAME,
    body: data.description,
  };
}

async function playNotificationSound(id: number) {
  const clients = await self.clients.matchAll({ type: 'window' }) as WindowClient[];
  const clientsInScope = clients.filter((client) => client.url === self.registration.scope);
  const client = clientsInScope[0];
  if (!client) return;
  if (clientsInScope.length === 0) return;
  client.postMessage({
    type: 'playNotificationSound',
    payload: { id },
  });
}

async function showNotification({
  chatId,
  messageId,
  body,
  title,
  icon,
}: NotificationData) {
  const tag = String(chatId || 0);
  const options: NotificationOptions = {
    body,
    data: {
      chatId,
      messageId,
      count: 1,
    },
    icon: icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag,
    vibrate: [200, 100, 200],
  };
  const notifications = await self.registration.getNotifications({ tag });
  if (notifications.length > 0) {
    const current = notifications[0];
    const count = current.data.count + 1;
    options.data.count = count;
    options.data.messageId = current.data.messageId;
    options.body = `You have ${count} new messages`;
    current.close();
  }
  return Promise.all([
    playNotificationSound(messageId || chatId || 0),
    self.registration.showNotification(title, options),
  ]);
}

export function handlePush(e: PushEvent) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Push received event', e);
    if (e.data) {
      // eslint-disable-next-line no-console
      console.log('[SW] Push received with data', e.data.json());
    }
  }

  const data = getPushData(e);

  // Do not show muted notifications
  if (!data || data.mute === Boolean.True) return;

  const notification = getNotificationData(data);

  // Dont show already triggered notification
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    return;
  }

  e.waitUntil(showNotification(notification));
}

async function focusChatMessage(client: WindowClient, data: { chatId?: number; messageId?: number }) {
  const {
    chatId,
    messageId,
  } = data;
  if (!chatId) return;
  client.postMessage({
    type: 'focusMessage',
    payload: {
      chatId,
      messageId,
    },
  });
  // Catch "focus not allowed" DOM Exceptions
  try {
    await client.focus();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[SW] ', error);
    }
  }
}

export function handleNotificationClick(e: NotificationEvent) {
  const appUrl = new URL(self.registration.scope).origin;
  e.notification.close(); // Android needs explicit close.
  const { data } = e.notification;
  const notifyClients = async () => {
    const clients = await self.clients.matchAll({ type: 'window' }) as WindowClient[];
    const clientsInScope = clients.filter((client) => {
      return new URL(client.url).origin === appUrl;
    });
    await Promise.all(clientsInScope.map((client) => {
      clickBuffer[client.id] = data;
      return focusChatMessage(client, data);
    }));
    if (!self.clients.openWindow || clientsInScope.length > 0) return undefined;
    // Store notification data for default client (fix for android)
    clickBuffer[0] = data;
    // If there is no opened client we need to open one and wait until it is fully loaded
    try {
      const newClient = await self.clients.openWindow(appUrl);
      if (newClient) {
        // Store notification data until client is fully loaded
        clickBuffer[newClient.id] = data;
      }
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[SW] ', error);
      }
    }
    return undefined;
  };
  e.waitUntil(notifyClients());
}

export function handleClientMessage(e: ExtendableMessageEvent) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] New message from client', e);
  }
  if (!e.data) return;
  const source = e.source as WindowClient;
  if (e.data.type === 'clientReady') {
    // focus on chat message when client is fully ready
    const data = clickBuffer[source.id] || clickBuffer[0];
    if (data) {
      delete clickBuffer[source.id];
      delete clickBuffer[0];
      e.waitUntil(focusChatMessage(source, data));
    }
  }
  if (e.data.type === 'newMessageNotification') {
    // Do not show notifications right after sync (when browser is opened)
    // To avoid stale notifications
    if (new Date().valueOf() - lastSyncAt < 3000) return;

    // store messageId for already shown notification
    const notification: NotificationData = e.data.payload;
    // mark this notification as shown if it was handled locally
    shownNotifications.add(notification.messageId);
    e.waitUntil(showNotification(notification));
  }
}

self.onsync = () => {
  lastSyncAt = new Date().valueOf();
};
