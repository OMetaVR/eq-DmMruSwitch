/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs, IS_MAC } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Button, ChannelRouter, ChannelStore, IconUtils, React, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

const STORAGE_KEY = "DmMruSwitch_history";
const MAX_HISTORY = 50;

let mruDmChannelIds: string[] = [];
let isCyclingSessionActive = false;
let suppressMruWhileCycling = false;
let cycleSnapshot: string[] = [];
let cycleIndex = -1;

const settings = definePluginSettings({
    visualStyle: {
        type: OptionType.SELECT,
        description: "Visual indicator style while cycling",
        options: [
            { label: "Overlay (Alt+Tab style)", value: "overlay", default: true },
            { label: "Toast (status message)", value: "toast" },
            { label: "Off", value: "off" }
        ]
    },
    overlayMode: {
        type: OptionType.SELECT,
        description: "Overlay content",
        options: [
            { label: "Row of recent", value: "row", default: true },
            { label: "Current only", value: "current" }
        ]
    },
    overlayRowLength: {
        type: OptionType.SLIDER,
        description: "Number of recent DMs to show in row",
        markers: [3, 4, 5, 6, 7],
        default: 5
    },
    overlayShowAvatars: {
        type: OptionType.BOOLEAN,
        description: "Show avatars in overlay",
        default: true
    },
    toastDurationMs: {
        type: OptionType.SLIDER,
        description: "Toast hide delay (ms)",
        markers: [300, 500, 600, 800, 1000, 1500, 2000],
        default: 600
    },
    instantSwitch: {
        type: OptionType.BOOLEAN,
        description: "Switch immediately on Tab instead of on Ctrl release",
        default: true
    },
    clearMru: {
        type: OptionType.COMPONENT,
        description: "Testing utility: Clear MRU list",
        component: () => React.createElement(
            Button,
            {
                color: Button.Colors.RED,
                onClick: async () => {
                    mruDmChannelIds = [];
                    cycleSnapshot = [];
                    cycleIndex = -1;
                    await DataStore.set(STORAGE_KEY, []);
                    Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Cleared DM MRU history" });
                }
            },
            "Clear MRU History"
        )
    }
});

let activeToastId: string | null = null;
let overlayRoot: HTMLDivElement | null = null;

function isDirectMessageChannel(channelId: string | null | undefined): boolean {
    if (!channelId) return false;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;
    try {
        // Include 1:1 DMs and Group DMs
        return Boolean(channel.isDM?.() || channel.isGroupDM?.());
    } catch {
        return false;
    }
}

function pushChannelToFront(channelId: string) {
    mruDmChannelIds = mruDmChannelIds.filter(id => id !== channelId);
    mruDmChannelIds.unshift(channelId);
    if (mruDmChannelIds.length > MAX_HISTORY) mruDmChannelIds.length = MAX_HISTORY;
    void DataStore.set(STORAGE_KEY, mruDmChannelIds);
}

function sanitizeHistory(ids: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        if (!ChannelStore.hasChannel(id)) continue;
        if (!isDirectMessageChannel(id)) continue;
        seen.add(id);
        result.push(id);
        if (result.length >= MAX_HISTORY) break;
    }
    return result;
}

function beginCycleSession() {
    if (isCyclingSessionActive) return;
    isCyclingSessionActive = true;
    suppressMruWhileCycling = true;

    const currentId = SelectedChannelStore.getChannelId();
    // Take a stable snapshot for the duration of the cycle
    cycleSnapshot = sanitizeHistory([
        ...(isDirectMessageChannel(currentId) ? [currentId!] : []),
        ...mruDmChannelIds
    ]);

    // Anchor is index 0 (current); next Tab should go to index 1
    cycleIndex = 0;
}

function stepCycle(direction: 1 | -1) {
    if (!isCyclingSessionActive || cycleSnapshot.length === 0) return;
    const total = cycleSnapshot.length;
    if (total <= 1) return;

    cycleIndex = (cycleIndex + direction + total) % total;
    const targetId = cycleSnapshot[cycleIndex];
    if (!targetId || !ChannelStore.hasChannel(targetId)) return;
    if (settings.store.instantSwitch) ChannelRouter.transitionToChannel(targetId);
    const vis = (settings as any).store?.visualStyle;
    if (vis === "overlay") renderOverlay();
    else if (vis === "toast") showCycleToast();
}

function endCycleSession() {
    if (!isCyclingSessionActive) return;
    isCyclingSessionActive = false;
    suppressMruWhileCycling = false;

    if (cycleIndex >= 0 && cycleIndex < cycleSnapshot.length) {
        const selected = cycleSnapshot[cycleIndex];
        if (selected && !settings.store.instantSwitch) ChannelRouter.transitionToChannel(selected);
        if (selected) pushChannelToFront(selected);
    }

    cycleSnapshot = [];
    cycleIndex = -1;
    activeToastId = null;

    const visEnd = (settings as any).store?.visualStyle;
    if (visEnd === "overlay") unmountOverlay();
}

function stopEvent(e: KeyboardEvent) {
    try {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    } catch { }
}

function onKeyDown(e: KeyboardEvent) {
    const hasCtrl = e.ctrlKey || (IS_MAC && e.metaKey);
    if (!hasCtrl) return;

    if (e.key === "Tab") {
        stopEvent(e);
        if (!isCyclingSessionActive) beginCycleSession();
        stepCycle(e.shiftKey ? -1 : 1);
    }
}

function onKeyUp(e: KeyboardEvent) {
    // Finalize when the modifier is released
    if (e.key === "Control" || (IS_MAC && e.key === "Meta")) {
        stopEvent(e);
        // If neither ctrl nor meta are pressed anymore, end the session
        const stillHeld = (e as any).ctrlKey || (e as any).metaKey;
        if (!stillHeld) endCycleSession();
    }
}

function getDisplayForChannel(id: string) {
    const ch = ChannelStore.getChannel(id);
    if (!ch) return { name: "Unknown", avatar: "" };
    if (ch.isDM?.()) {
        const uid = ch.recipients?.[0];
        const user = uid ? UserStore.getUser(uid) : null;
        return { name: user?.globalName ?? user?.username ?? "DM", avatar: user ? IconUtils.getUserAvatarURL(user, true, 64) : "" };
    }
    if (ch.isGroupDM?.()) {
        return { name: ch.name ?? "Group DM", avatar: IconUtils.getChannelIconURL?.(ch) ?? "" } as any;
    }
    return { name: ch.name ?? "Channel", avatar: "" };
}

function ensureOverlayRoot() {
    if (!overlayRoot) {
        overlayRoot = document.createElement("div");
        overlayRoot.id = "vc-dm-mru-overlay";
        overlayRoot.style.position = "fixed";
        overlayRoot.style.zIndex = "99999";
        overlayRoot.style.pointerEvents = "none";
        overlayRoot.style.opacity = "0";
        overlayRoot.style.transition = "opacity 150ms ease";
        overlayRoot.style.inset = "0"; // allow backdrop fill in center mode
        document.body.appendChild(overlayRoot);
    }
}

function positionOverlay() {
    if (!overlayRoot) return;
    overlayRoot.style.inset = "0";
    overlayRoot.style.display = "grid";
    overlayRoot.style.placeItems = "center";
    overlayRoot.style.background = "rgba(0,0,0,0.38)";
    overlayRoot.style.backdropFilter = "blur(2px)";
}

function renderOverlay() {
    if (settings.store.visualStyle !== "overlay") return;
    if (!isCyclingSessionActive) return;
    ensureOverlayRoot();
    positionOverlay();
    if (!overlayRoot) return;

    const mode = settings.store.overlayMode;
    const showAvatars = settings.store.overlayShowAvatars;
    const maxCount = Math.max(3, Math.min(7, settings.store.overlayRowLength));

    const pageSize = mode === "current" ? 1 : maxCount;
    const totalSlots = mode === "current" ? 1 : pageSize * 2; // target 10 when pageSize=5
    const visibleList = mode === "current"
        ? [cycleSnapshot[cycleIndex]]
        : cycleSnapshot.slice(0, totalSlots);

    let pageCount = 1;
    let currentPage = 0;
    if (mode !== "current") {
        pageCount = visibleList.length > pageSize ? 2 : 1;
        currentPage = Math.min(pageCount - 1, Math.floor((cycleIndex >= 0 ? cycleIndex : 0) / pageSize));
    }

    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, visibleList.length);
    const pageItems = visibleList.slice(start, end);
    const cards = pageItems.map(id => {
        const { name, avatar } = getDisplayForChannel(id!);
        const isActive = id === cycleSnapshot[cycleIndex];
        const cardW = 168; // 16:9 width for 94.5px height (we'll constrain height)
        const cardH = Math.round(cardW * 9 / 16);
        const img = showAvatars && avatar ? `<img src="${avatar}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;${isActive ? "outline:2px solid var(--brand-500);" : "opacity:0.8;"}"/>` : "";
        const label = `<div style="margin-top:8px;color:var(--header-primary);font-size:12px;max-width:${cardW - 16}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;">${name}</div>`;
        const shadow = isActive ? "box-shadow:0 0 0 2px var(--brand-500) inset, 0 4px 12px rgba(0,0,0,0.25);" : "box-shadow:0 2px 8px rgba(0,0,0,0.15);";
        return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:${cardW}px;height:${cardH}px;border-radius:10px;background:var(--background-floating);${shadow}">${img}${label}</div>`;
    }).join("");

    const dots = pageCount > 1
        ? `<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:10px;">
                ${Array.from({ length: pageCount }).map((_, i) => `<div style="width:8px;height:8px;border-radius:50%;background:${i === currentPage ? "var(--brand-500)" : "var(--interactive-muted)"};opacity:${i === currentPage ? "1" : "0.6"}"></div>`).join("")}
           </div>`
        : "";

    overlayRoot.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;padding:12px 16px;border-radius:12px;background:color-mix(in oklab, var(--background-floating) 85%, transparent);backdrop-filter:saturate(120%); box-shadow:0 6px 24px rgba(0,0,0,0.25);">
            <div style="display:flex;gap:12px;align-items:center;justify-content:center;">${cards}</div>
            ${dots}
        </div>`;
    // fade in
    requestAnimationFrame(() => { if (overlayRoot) overlayRoot.style.opacity = "1"; });
}

function unmountOverlay() {
    if (!overlayRoot) return;
    overlayRoot.style.opacity = "0";
    const node = overlayRoot;
    overlayRoot = null;
    setTimeout(() => node.remove(), 180);
}

function showCycleToast() {
    if (settings.store.visualStyle !== "toast") return;
    const id = cycleSnapshot[cycleIndex];
    if (!id) return;
    const { name } = getDisplayForChannel(id);
    // Reuse the same toast ID so content updates and timer resets smoothly
    if (!activeToastId) activeToastId = Toasts.genId();
    Toasts.show({
        id: activeToastId,
        message: `Switching to: ${name}`,
        type: Toasts.Type.MESSAGE,
        options: { position: Toasts.Position.BOTTOM, duration: settings.store.toastDurationMs }
    });
}

export default definePlugin({
    name: "DmMruSwitch",
    description: "Ctrl+Tab between most recently used DMs (Ctrl+Shift+Tab reverse)",
    authors: [EquicordDevs.mmeta],
    enabledByDefault: true,
    settings,

    flux: {
        // Some environments still trigger guild navigation on Ctrl+Tab.
        // If that happens during an active cycle, immediately bounce back to the DM target.
        GUILD_SELECT({ guildId }: { guildId: string | null; }) {
            if (!isCyclingSessionActive) return;
            if (guildId) {
                const targetId = cycleSnapshot[cycleIndex];
                if (targetId) ChannelRouter.transitionToChannel(targetId);
            }
        },
        async CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            if (suppressMruWhileCycling) return;
            if (!channelId) return;
            if (!isDirectMessageChannel(channelId)) return;
            pushChannelToFront(channelId);
        }
    },

    async start() {
        // Load history and seed with current DM if applicable
        const saved = await DataStore.get<string[]>(STORAGE_KEY);
        mruDmChannelIds = Array.isArray(saved) ? sanitizeHistory(saved) : [];

        const current = SelectedChannelStore.getChannelId();
        if (isDirectMessageChannel(current)) pushChannelToFront(current!);

        // Capture early and also attach bubble listeners to maximize suppression
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("keyup", onKeyUp, true);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
        // Window-level as an extra guard
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("keyup", onKeyUp, true);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("keyup", onKeyUp, true);
        isCyclingSessionActive = false;
        suppressMruWhileCycling = false;
        cycleSnapshot = [];
        cycleIndex = -1;
        activeToastId = null;

        const visEnd = (settings as any).store?.visualStyle;
        if (visEnd === "overlay") unmountOverlay();
    }
});


