import electron from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCreditsPageUrl,
  parseCodexAdminIdentity,
  fetchCreditSnapshot,
  type CodexAdminIdentity,
} from "./credits";
import { exhaustedWindowKey } from "./auto-reset";
import { consumeBankedReset, readCurrentSnapshot, readLiveRateLimits } from "./usage";
import type { CreditSnapshot, MonitorSnapshot, RateLimitWindow } from "./types";

const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, session } = electron;
const appName = "Codex Monitor";
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const appIconPath = join(currentDirectory, "../assets/codex-monitor.png");
const menuBarIconPath = join(currentDirectory, "../assets/codex-monitorTemplate.png");
const codexDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const adminPartition = "persist:codex-monitor-admin";
const launchAgentLabel = "com.codex-monitor.widget";
const launchAgentPath = join(homedir(), "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
const usageRefreshMilliseconds = 2_000;
const liveUsageCacheMilliseconds = 15_000;
const creditsRefreshMilliseconds = 60_000;
const creditPriceUsd = 0.056;
const baseWidgetWidth = 340;
const fullWidgetHeight = 336;
const compactWidgetHeight = 266;
const creditsSectionHeight = 112;
type Window = InstanceType<typeof BrowserWindow>;
type StatusTray = InstanceType<typeof Tray>;
interface Preferences {
  alwaysOnTop?: boolean;
  hideFromDock?: boolean;
  showPercentageLeftInMenuBar?: boolean;
  widgetWidth?: number;
  automaticallyUseResets?: boolean;
  automaticResetAttemptKey?: string;
  analyticsSignedOut?: boolean;
}

let mainWindow: Window | undefined;
let adminWindow: Window | undefined;
let creditLoginPending = false;
let analyticsSignedOut = false;
let analyticsGeneration = 0;
let analyticsLoggingOut = false;
let creditIntroductionWindow: Window | undefined;
let tray: StatusTray | undefined;
let usageSnapshot: MonitorSnapshot | undefined;
let usageRead: Promise<MonitorSnapshot | undefined> | undefined;
let usageReadAt = 0;
let creditSnapshot: CreditSnapshot | undefined;
let creditsRead: Promise<CreditSnapshot> | undefined;
let alwaysOnTop = true;
let hideFromDock = true;
let showPercentageLeftInMenuBar = true;
let automaticallyUseResets = false;
let automaticResetAttemptKey: string | undefined;
let automaticResetInFlight = false;
let widgetWidth = baseWidgetWidth;
let compactWidget = false;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let isQuitting = false;

app.setName(appName);
process.title = appName;

function createWindow(): void {
  const aspectRatio = currentWidgetAspectRatio();
  mainWindow = new BrowserWindow({
    width: widgetWidth,
    height: Math.round(widgetWidth / aspectRatio),
    minWidth: 220,
    minHeight: Math.round(220 / aspectRatio),
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    alwaysOnTop,
    icon: appIconPath,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAspectRatio(aspectRatio);
  applyAlwaysOnTop();
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow();
  });
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);
  mainWindow.on("resize", rememberWidgetSize);
  mainWindow.loadFile(join(currentDirectory, "../ui/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

function currentWidgetAspectRatio(): number {
  const height = (compactWidget ? compactWidgetHeight : fullWidgetHeight)
    - (creditSnapshot?.status === "ready" ? 0 : creditsSectionHeight);
  return baseWidgetWidth / height;
}

function setCompactWidget(compact: boolean): void {
  if (compactWidget === compact) return;
  compactWidget = compact;
  resizeWidgetForLayout();
}

function resizeWidgetForLayout(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const width = mainWindow.getBounds().width;
  const aspectRatio = currentWidgetAspectRatio();
  widgetWidth = width;
  mainWindow.setAspectRatio(aspectRatio);
  mainWindow.setMinimumSize(220, Math.round(220 / aspectRatio));
  mainWindow.setSize(width, Math.round(width / aspectRatio), true);
}

function hideWindow(): void {
  mainWindow?.hide();
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function setWidgetVisible(visible: boolean): void {
  if (visible) showWindow();
  else hideWindow();
}

function rememberWidgetSize(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  widgetWidth = mainWindow.getBounds().width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    void savePreferences().catch((error) => {
      console.error("Could not save the widget size", error);
    });
  }, 300);
}

function applyAlwaysOnTop(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(alwaysOnTop, "floating");
  mainWindow.setVisibleOnAllWorkspaces(alwaysOnTop, {
    visibleOnFullScreen: alwaysOnTop,
  });
}

async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  alwaysOnTop = enabled;
  applyAlwaysOnTop();
  updateTrayMenu();
  try {
    await savePreferences();
  } catch (error) {
    console.error("Could not save the always-on-top setting", error);
  }
}

function applyDockVisibility(): void {
  if (process.platform !== "darwin") return;
  if (hideFromDock) {
    app.dock?.hide();
  } else {
    void app.dock?.show();
  }
}

async function setHideFromDock(enabled: boolean): Promise<void> {
  hideFromDock = enabled;
  applyDockVisibility();
  updateTrayMenu();
  try {
    await savePreferences();
  } catch (error) {
    console.error("Could not save the Dock visibility setting", error);
  }
}

async function setShowPercentageLeftInMenuBar(enabled: boolean): Promise<void> {
  showPercentageLeftInMenuBar = enabled;
  updateTrayMenu();
  try {
    await savePreferences();
  } catch (error) {
    console.error("Could not save the menu-bar percentage setting", error);
  }
}

async function setAutomaticallyUseResets(enabled: boolean): Promise<void> {
  automaticallyUseResets = enabled;
  updateTrayMenu();
  mainWindow?.webContents.send("settings:auto-resets-changed", enabled);
  try {
    await savePreferences();
  } catch (error) {
    automaticallyUseResets = false;
    updateTrayMenu();
    mainWindow?.webContents.send("settings:auto-resets-changed", false);
    console.error("Could not save automatic reset setting", error);
  }
}

async function loadPreferences(): Promise<void> {
  try {
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as Preferences;
    analyticsSignedOut = stored.analyticsSignedOut === true;
    if (typeof stored.alwaysOnTop === "boolean") alwaysOnTop = stored.alwaysOnTop;
    if (typeof stored.hideFromDock === "boolean") hideFromDock = stored.hideFromDock;
    if (typeof stored.showPercentageLeftInMenuBar === "boolean") {
      showPercentageLeftInMenuBar = stored.showPercentageLeftInMenuBar;
    }
    if (typeof stored.automaticallyUseResets === "boolean") {
      automaticallyUseResets = stored.automaticallyUseResets;
    }
    if (typeof stored.automaticResetAttemptKey === "string") {
      automaticResetAttemptKey = stored.automaticResetAttemptKey;
    }
    if (typeof stored.widgetWidth === "number" && stored.widgetWidth >= 220) {
      widgetWidth = stored.widgetWidth;
    }
  } catch {
    alwaysOnTop = true;
    hideFromDock = true;
    widgetWidth = baseWidgetWidth;
  }
}

async function savePreferences(): Promise<void> {
  const path = preferencesPath();
  await mkdir(dirname(path), { recursive: true });
  const preferences = {
    alwaysOnTop, hideFromDock, showPercentageLeftInMenuBar, widgetWidth,
    automaticallyUseResets, automaticResetAttemptKey, analyticsSignedOut,
  };
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

function preferencesPath(): string {
  return join(app.getPath("userData"), "preferences.json");
}

async function readAdminIdentity(): Promise<CodexAdminIdentity | undefined> {
  try {
    const auth = await readFile(join(codexDirectory, "auth.json"), "utf8");
    return parseCodexAdminIdentity(auth);
  } catch {
    return undefined;
  }
}

async function getAdminWindow(identity: CodexAdminIdentity): Promise<Window> {
  if (adminWindow && !adminWindow.isDestroyed()) return adminWindow;

  adminWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 680,
    minHeight: 560,
    show: false,
    title: "Connect Codex credits",
    autoHideMenuBar: true,
    webPreferences: {
      partition: adminPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const window = adminWindow;
  window.on("closed", () => {
    if (adminWindow === window) {
      adminWindow = undefined;
      creditLoginPending = false;
    }
  });
  window.webContents.on("did-finish-load", checkCreditLogin);
  window.webContents.on("did-navigate-in-page", checkCreditLogin);

  adminWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await adminWindow.loadURL(buildCreditsPageUrl(identity));
  return window;
}

function isAdminCreditsPage(window: Window, identity: CodexAdminIdentity): boolean {
  try {
    const url = new URL(window.webContents.getURL());
    return url.origin === "https://admin.openai.com"
      && url.pathname.startsWith(`/workspace/${identity.workspaceId}/analytics/credits`);
  } catch {
    return false;
  }
}

function isAdminPage(window: Window): boolean {
  try {
    return new URL(window.webContents.getURL()).origin === "https://admin.openai.com";
  } catch {
    return false;
  }
}

function checkCreditLogin(): void {
  if (!creditLoginPending || !adminWindow?.isVisible() || !isAdminPage(adminWindow)) return;
  void getLatestCredits();
}

async function readCredits(generation: number): Promise<CreditSnapshot> {
  if (analyticsSignedOut || generation !== analyticsGeneration) return { status: "auth_required", days: [] };
  const identity = await readAdminIdentity();
  if (!identity) {
    return { status: "unavailable", days: [], message: "Codex login not found" };
  }

  if (analyticsSignedOut || generation !== analyticsGeneration) return { status: "auth_required", days: [] };
  const browserSession = session.fromPartition(adminPartition);
  return fetchCreditSnapshot(identity, (url, options) => browserSession.fetch(url, options));
}

async function connectCredits(): Promise<void> {
  if (creditIntroductionWindow && !creditIntroductionWindow.isDestroyed()) {
    creditIntroductionWindow.show();
    creditIntroductionWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 490,
    height: 600,
    useContentSize: true,
    minWidth: 490,
    minHeight: 200,
    resizable: false,
    show: false,
    title: "Connect credit analytics",
    icon: appIconPath,
    autoHideMenuBar: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  creditIntroductionWindow = window;
  window.on("closed", () => {
    if (creditIntroductionWindow === window) creditIntroductionWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadFile(join(currentDirectory, "../ui/connect.html"));
}

async function beginCreditLogin(): Promise<void> {
  if (analyticsLoggingOut) throw new Error("Logout is still in progress");
  analyticsSignedOut = false;
  analyticsGeneration += 1;
  creditsRead = undefined;
  await savePreferences();
  const identity = await readAdminIdentity();
  if (!identity) throw new Error("Codex login not found");
  const window = await getAdminWindow(identity);
  if (!isAdminCreditsPage(window, identity)) {
    await window.loadURL(buildCreditsPageUrl(identity));
  }
  creditLoginPending = true;
  window.show();
  window.focus();
  creditIntroductionWindow?.close();
  checkCreditLogin();
}

async function getLatestUsage(force = false): Promise<MonitorSnapshot | undefined> {
  if (!force && usageSnapshot && Date.now() - usageReadAt < liveUsageCacheMilliseconds) {
    return usageSnapshot;
  }
  usageRead ??= readCurrentSnapshot(codexDirectory).finally(() => {
    usageRead = undefined;
  });
  usageSnapshot = await usageRead;
  usageReadAt = Date.now();
  updateTrayMenu();
  void maybeAutomaticallyUseReset();
  return usageSnapshot;
}

async function maybeAutomaticallyUseReset(): Promise<void> {
  if (!automaticallyUseResets || automaticResetInFlight) return;
  if (!exhaustedWindowKey(usageSnapshot?.rateLimits ?? {})) return;
  automaticResetInFlight = true;
  try {
    // Recheck the live endpoint immediately before making a one-time reset attempt.
    const live = await readLiveRateLimits(codexDirectory);
    const key = exhaustedWindowKey(live);
    if (!automaticallyUseResets || !key || key === automaticResetAttemptKey) return;
    automaticResetAttemptKey = key;
    await savePreferences();
    if (!automaticallyUseResets) return;
    await consumeBankedReset(codexDirectory, randomUUID());
    await refreshAll();
  } catch (error) {
    console.error("Could not automatically use a banked reset", error);
  } finally {
    automaticResetInFlight = false;
  }
}

async function getLatestCredits(): Promise<CreditSnapshot> {
  const generation = analyticsGeneration;
  if (!creditsRead) {
    const pending = readCredits(generation).finally(() => {
      if (creditsRead === pending) creditsRead = undefined;
    });
    creditsRead = pending;
  }
  const snapshot = await creditsRead;
  if (generation !== analyticsGeneration) return creditSnapshot ?? { status: "auth_required", days: [] };
  const hadCredits = creditSnapshot?.status === "ready";
  if (snapshot.status === "access_denied" && !snapshot.account) snapshot.account = creditSnapshot?.account;
  creditSnapshot = snapshot;
  if (hadCredits !== (creditSnapshot.status === "ready")) resizeWidgetForLayout();
  updateTrayMenu();
  mainWindow?.webContents.send("credits:changed", creditSnapshot);
  if (creditLoginPending && (creditSnapshot.status === "ready"
    || (creditSnapshot.status === "access_denied" && creditSnapshot.account))) {
    creditLoginPending = false;
    const window = adminWindow;
    adminWindow = undefined;
    window?.destroy();
    showWindow();
    mainWindow?.webContents.send("monitor:refresh");
  }
  return creditSnapshot;
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled([getLatestUsage(true), getLatestCredits()]);
  mainWindow?.webContents.send("monitor:refresh");
}

function createTray(): void {
  const icon = nativeImage.createFromPath(menuBarIconPath);
  if (icon.isEmpty()) throw new Error("Could not create the menu-bar icon");
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(appName);
  updateTrayMenu();
}

async function logOutCreditAnalytics(): Promise<void> {
  if (analyticsLoggingOut) return;
  analyticsLoggingOut = true;
  analyticsSignedOut = true;
  analyticsGeneration += 1;
  creditLoginPending = false;
  creditsRead = undefined;
  creditSnapshot = { status: "auth_required", days: [] };
  const window = adminWindow;
  adminWindow = undefined;
  window?.destroy();
  resizeWidgetForLayout();
  updateTrayMenu();
  mainWindow?.webContents.send("monitor:refresh");
  try {
    const browserSession = session.fromPartition(adminPartition);
    await browserSession.closeAllConnections();
    await browserSession.clearData();
    await browserSession.clearAuthCache();
    browserSession.flushStorageData();
    await savePreferences();
  } finally {
    analyticsLoggingOut = false;
    updateTrayMenu();
  }
}

function analyticsAccountMenuItems(): Electron.MenuItemConstructorOptions[] {
  const account = creditSnapshot?.account;
  const accessDenied = creditSnapshot?.status === "access_denied";
  return [
    ...(account ? [
      { label: "Analytics account: " + account.email, enabled: false },
    ] : []),
    ...(accessDenied ? [{ label: "This account cannot access credit analytics", enabled: false }] : []),
    ...(account || accessDenied ? [
      { label: "Log out of credit analytics", enabled: !analyticsLoggingOut,
        click: () => void logOutCreditAnalytics().catch(error => console.error("Could not clear analytics login", error)) },
    ] : []),
    ...(creditSnapshot?.status === "ready" || accessDenied ? [] : [
      { label: analyticsLoggingOut ? "Logging out…" : "Connect credit analytics",
        enabled: !analyticsLoggingOut && creditSnapshot?.status !== "unavailable",
        click: () => void connectCredits() },
    ]),
  ];
}

function configureApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        ...analyticsAccountMenuItems(),
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ]));
}

function updateTrayMenu(): void {
  configureApplicationMenu();
  if (!tray) return;
  const topLimit = usageSnapshot?.rateLimits.primary ?? usageSnapshot?.rateLimits.secondary;
  const remainingPercent = topLimit
    ? Math.max(0, Math.min(100, 100 - topLimit.used_percent))
    : undefined;
  tray.setTitle(showPercentageLeftInMenuBar && remainingPercent !== undefined
    ? `${formatPercent(remainingPercent)}%`
    : "");
  const usageWindows = [
    { name: "5 hour", limit: usageSnapshot?.rateLimits.primary },
    { name: "Weekly", limit: usageSnapshot?.rateLimits.secondary },
  ].filter((entry): entry is { name: string; limit: RateLimitWindow } => Boolean(entry.limit));
  const usageItems = usageWindows.length
    ? usageWindows.flatMap((entry, index): Electron.MenuItemConstructorOptions[] => [
        ...(index ? [{ type: "separator" as const }] : []),
        ...usageMenuItems(entry.name, entry.limit),
      ])
    : [{ label: "Usage unavailable", enabled: false }];
  const paidCredits = formatPaidCredits(creditSnapshot);
  const adminLoginItems = analyticsAccountMenuItems();
  const startAtLogin = isStartAtLoginEnabled();

  tray.setContextMenu(Menu.buildFromTemplate([
    ...usageItems,
    { label: usageSnapshot?.rateLimits.bankedResets == null
      ? "Banked usage resets: unavailable"
      : `Banked usage resets: ${usageSnapshot.rateLimits.bankedResets}`, enabled: false },
    { type: "separator" },
    { label: paidCredits, enabled: false },
    ...adminLoginItems,
    { type: "separator" },
    {
      label: "Refresh now",
      click: () => void refreshAll(),
    },
    {
      label: "Show widget",
      type: "checkbox",
      checked: mainWindow?.isVisible() ?? false,
      click: (item) => setWidgetVisible(item.checked),
    },
    {
      label: "Always on top",
      type: "checkbox",
      checked: alwaysOnTop,
      click: (item) => void setAlwaysOnTop(item.checked),
    },
    {
      label: "Hide from Dock",
      type: "checkbox",
      checked: hideFromDock,
      click: (item) => void setHideFromDock(item.checked),
    },
    {
      label: "Show percentage left in menu bar",
      type: "checkbox",
      checked: showPercentageLeftInMenuBar,
      click: (item) => void setShowPercentageLeftInMenuBar(item.checked),
    },
    {
      label: "Automatically Use Resets",
      type: "checkbox",
      checked: automaticallyUseResets,
      click: (item) => void setAutomaticallyUseResets(item.checked),
    },
    {
      label: "Start on boot",
      type: "checkbox",
      checked: startAtLogin,
      click: (item) => void setStartAtLogin(item.checked),
    },
    { type: "separator" },
    {
      label: "Quit Codex Monitor",
      click: () => app.quit(),
    },
  ]));
}

function usageMenuItems(name: string, limit: RateLimitWindow): Electron.MenuItemConstructorOptions[] {
  const remainingPercent = Math.max(0, Math.min(100, 100 - limit.used_percent));
  const reset = new Date(limit.resets_at * 1_000);
  return [
    { label: `${name} left: ${formatPercent(remainingPercent)}%`, enabled: false },
    { label: `Resets: ${formatDuration(reset.getTime() - Date.now())} · ${formatReset(reset)}`, enabled: false },
  ];
}

function formatPaidCredits(snapshot?: CreditSnapshot): string {
  if (!snapshot) return "Credits today: loading…";
  if (snapshot.status !== "ready") return "Credits today: unavailable";
  const today = new Date().toISOString().slice(0, 10);
  const credits = snapshot.days.find((day) => day.date === today)?.credits ?? 0;
  return `Paid credits today: ${formatCreditAmount(credits)} cr · ${formatUsd(credits * creditPriceUsd)}`;
}

function formatCreditAmount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: value === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatReset(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function isStartAtLoginEnabled(): boolean {
  if (process.platform === "darwin" && !app.isPackaged) return existsSync(launchAgentPath);
  return app.getLoginItemSettings().openAtLogin;
}

async function setStartAtLogin(enabled: boolean): Promise<void> {
  try {
    if (process.platform === "darwin" && !app.isPackaged) {
      if (enabled) {
        await mkdir(dirname(launchAgentPath), { recursive: true });
        await writeFile(launchAgentPath, buildLaunchAgent(), "utf8");
      } else {
        await unlink(launchAgentPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
  } catch (error) {
    console.error("Could not update start-on-boot setting", error);
  }
  updateTrayMenu();
}

async function migrateLegacyLoginItem(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged || !existsSync(launchAgentPath)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    if (app.getLoginItemSettings().openAtLogin) await unlink(launchAgentPath);
  } catch (error) {
    console.error("Could not migrate the start-on-boot setting", error);
  }
}

function buildLaunchAgent(): string {
  const argumentsList = [process.execPath, app.getAppPath()]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${launchAgentLabel}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsList}
    </array>
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

ipcMain.handle("usage:latest", () => getLatestUsage());
ipcMain.handle("settings:auto-resets", () => automaticallyUseResets);
ipcMain.handle("settings:set-auto-resets", async (event, enabled: unknown) => {
  if (event.sender !== mainWindow?.webContents || typeof enabled !== "boolean") {
    throw new Error("Invalid automatic reset setting");
  }
  await setAutomaticallyUseResets(enabled);
  return automaticallyUseResets;
});
ipcMain.handle("credits:latest", getLatestCredits);
ipcMain.on("credits:fit-introduction", (event, height: unknown) => {
  const window = creditIntroductionWindow;
  if (!window || event.sender !== window.webContents || typeof height !== "number"
    || !Number.isFinite(height) || height < 200 || height > 1400) return;
  window.setContentSize(490, Math.ceil(height));
  if (!window.isVisible()) window.show();
});
ipcMain.handle("credits:begin-login", async (event) => {
  if (event.sender !== creditIntroductionWindow?.webContents) {
    throw new Error("Credit login must start from the introduction");
  }
  await beginCreditLogin();
});
ipcMain.on("credits:dismiss-introduction", (event) => {
  if (event.sender === creditIntroductionWindow?.webContents) creditIntroductionWindow?.close();
});
ipcMain.on("window:hide", hideWindow);
ipcMain.on("window:set-compact", (_event, compact: unknown) => {
  if (typeof compact === "boolean") setCompactWidget(compact);
});

app.whenReady().then(async () => {
  await loadPreferences();
  await migrateLegacyLoginItem();
  app.setAboutPanelOptions({ applicationName: appName });
  app.dock?.setIcon(appIconPath);
  configureApplicationMenu();
  applyDockVisibility();
  createWindow();
  createTray();
  void refreshAll();
  setInterval(() => {
    void getLatestUsage();
    checkCreditLogin();
  }, usageRefreshMilliseconds);
  setInterval(() => void getLatestCredits(), creditsRefreshMilliseconds);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", showWindow);
