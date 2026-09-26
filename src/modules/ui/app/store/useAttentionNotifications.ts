// A browser notification when a run starts waiting for the reader.
//
// The dashboard lives in a background tab most of the night: the count in the
// title is the only other signal, and nobody reads a tab title from across the
// room. The rule deciding what is new is `newlyWaiting`, pure and tested; this
// hook owns what React and the browser own — the set of keys the previous poll
// saw, the permission, and the click that brings the item on screen.
//
// Nothing is announced while the page is in the foreground: the reader is
// looking at the list the item just appeared in.

import { useEffect, useRef, useState } from "react";
import type { Item } from "../api/types.js";
import { newlyWaiting, reasonOf, waitingKeys } from "../lib/derive.js";
import { actions, useUiSelector } from "./store.js";
import { navigate } from "./useRoute.js";

/** `unsupported` covers both a browser without the API and a page served over
 *  plain HTTP from a host other than loopback, where browsers refuse it. */
export type NotifyPermission = NotificationPermission | "unsupported";

function currentPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** The permission, and the one way to ask for it — from a click, as browsers require. */
export function useNotificationPermission(): [NotifyPermission, () => void] {
  const [permission, setPermission] = useState<NotifyPermission>(currentPermission);
  const ask = (): void => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then(setPermission);
  };
  return [permission, ask];
}

function announce(item: Item): void {
  const title = item.group === "decision" ? `${item.ticket} needs a decision` : `${item.ticket} failed`;
  const notification = new Notification(title, { body: `${item.project.name} · ${reasonOf(item)}`, tag: item.key });
  notification.onclick = () => {
    window.focus();
    navigate({ view: "inbox" });
    actions.setFilter(null);
    actions.select(item.key);
    notification.close();
  };
}

export function useAttentionNotifications(): void {
  const items = useUiSelector((state) => state.items);
  const loaded = useUiSelector((state) => state.loaded && state.user !== null);
  const previous = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const fresh = newlyWaiting(previous.current, items);
    previous.current = waitingKeys(items);
    if (fresh.length === 0 || !document.hidden || currentPermission() !== "granted") return;
    for (const item of fresh) announce(item);
  }, [items, loaded]);
}
