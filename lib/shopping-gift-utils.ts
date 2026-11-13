import { CHAT_REQUEST_REPLY_EVENT, createOrGetSession, loadChatMessages, loadChatSessions, pushChatMessage } from "./chat-storage";
import { resolveUserIdentity } from "./settings-storage";
import { loadShoppingState, saveShoppingState } from "./shopping-storage";
import type { ShoppingOrder } from "./shopping-types";
import type { CheckPhoneShoppingTone } from "./checkphone-config";

export type ShoppingGiftCandidate = {
  id: string;
  orderId: string;
  itemId: string;
  unitIndex: number;
  productName: string;
  merchantLabel: string;
  priceLabel: string;
  quantityLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
  deliveredAt?: string;
  deliveredTimeLabel?: string;
  orderTimeLabel: string;
};

type LoadShoppingGiftOptions = {
  includeSent?: boolean;
  nowMs?: number;
};

function parseGiftQuantity(label?: string): number {
  const match = String(label ?? "").match(/\d+/);
  const amount = match ? Number(match[0]) : 1;
  if (!Number.isFinite(amount)) return 1;
  return Math.min(50, Math.max(1, Math.round(amount)));
}

function parseTimestamp(value?: string): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getDeliveredEvent(order: ShoppingOrder) {
  return order.shippingTimeline?.find(event => event.status === "delivered");
}

function isOrderDelivered(order: ShoppingOrder, nowMs: number): boolean {
  const deliveredEvent = getDeliveredEvent(order);
  if (deliveredEvent) {
    const deliveredMs = parseTimestamp(deliveredEvent.timestamp);
    return deliveredMs > 0 && deliveredMs <= nowMs;
  }
  return /已到货|已签收|已完成/.test(order.statusLabel);
}

export function loadSentShoppingGiftIds(): Set<string> {
  const sentIds = new Set<string>();
  for (const session of loadChatSessions()) {
    for (const message of loadChatMessages(session.id)) {
      if (message.mediaType !== "gift") continue;
      const giftId = message.mediaData?.shoppingGiftId;
      if (giftId) sentIds.add(giftId);
    }
  }
  return sentIds;
}

export function loadDeliveredShoppingGifts(options: LoadShoppingGiftOptions = {}): ShoppingGiftCandidate[] {
  const nowMs = options.nowMs ?? Date.now();
  const sentIds = options.includeSent ? new Set<string>() : loadSentShoppingGiftIds();
  const state = loadShoppingState();
  const gifts: ShoppingGiftCandidate[] = [];

  for (const order of state.orders) {
    if (!isOrderDelivered(order, nowMs)) continue;
    const deliveredEvent = getDeliveredEvent(order);

    order.items.forEach((item, itemIndex) => {
      const quantity = parseGiftQuantity(item.quantityLabel);
      for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
        const giftId = `${order.id}::${item.id || itemIndex}::${unitIndex}`;
        if (sentIds.has(giftId)) continue;
        gifts.push({
          id: giftId,
          orderId: order.id,
          itemId: item.id || `${itemIndex}`,
          unitIndex,
          productName: item.title,
          merchantLabel: item.merchantLabel || order.merchantLabel,
          priceLabel: item.priceLabel,
          quantityLabel: quantity > 1 ? `第 ${unitIndex}/${quantity} 件` : item.quantityLabel || "x 1",
          subtitle: item.subtitle,
          detail: item.detail,
          previewIcon: item.previewIcon,
          tone: item.tone,
          deliveredAt: deliveredEvent?.timestamp,
          deliveredTimeLabel: deliveredEvent?.timeLabel,
          orderTimeLabel: order.timeLabel,
        });
      }
    });
  }

  return gifts.sort((a, b) => {
    const timeDiff = parseTimestamp(b.deliveredAt) - parseTimestamp(a.deliveredAt);
    if (timeDiff !== 0) return timeDiff;
    return b.orderId.localeCompare(a.orderId);
  });
}

export function processDueGiftOrders(nowMs: number = Date.now()): string[] {
  const state = loadShoppingState();
  const sentIds = loadSentShoppingGiftIds();
  const triggeredSessionIds = new Set<string>();
  let stateChanged = false;
  const nowIso = new Date(nowMs).toISOString();

  const nextOrders = state.orders.map(order => {
    if (!order.giftRecipientId || order.giftAutoSentAt) return order;
    if (!isOrderDelivered(order, nowMs)) return order;

    const deliveredEvent = getDeliveredEvent(order);
    const session = createOrGetSession(order.giftRecipientId);
    const senderName = resolveUserIdentity(order.giftRecipientId, "chat")?.name || "你";
    let sentAny = false;

    order.items.forEach((item, itemIndex) => {
      const quantity = parseGiftQuantity(item.quantityLabel);
      for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
        const giftId = `${order.id}::${item.id || itemIndex}::${unitIndex}`;
        if (sentIds.has(giftId)) continue;
        sentIds.add(giftId);
        pushChatMessage({
          sessionId: session.id,
          role: "user",
          content: "",
          mediaType: "gift",
          mediaData: {
            label: item.title,
            giftName: item.title,
            shoppingGiftId: giftId,
            giftOrderId: order.id,
            giftItemId: item.id || `${itemIndex}`,
            giftMerchantLabel: item.merchantLabel || order.merchantLabel,
            giftPriceLabel: item.priceLabel,
            giftDetail: item.detail || item.subtitle,
            giftPreviewIcon: item.previewIcon,
            giftTone: item.tone,
            giftDeliveredAt: deliveredEvent?.timestamp || nowIso,
            giftSentAt: nowIso,
            senderName,
            recipientId: order.giftRecipientId,
            recipientName: order.giftRecipientName,
          },
        });
        sentAny = true;
      }
    });

    if (sentAny && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
      triggeredSessionIds.add(session.id);
    }

    stateChanged = true;
    return {
      ...order,
      giftAutoSentAt: nowIso,
    };
  });

  if (stateChanged) {
    saveShoppingState({ ...state, orders: nextOrders });
  }

  return [...triggeredSessionIds];
}

export function triggerGiftRecipientReply(sessionId: string, characterId?: string): void {
  if (typeof window === "undefined" || !sessionId) return;
  window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, {
    detail: {
      sessionId,
      ...(characterId ? { characterId } : {}),
    },
  }));
}
