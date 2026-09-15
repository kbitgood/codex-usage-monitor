import electron from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCreditsDataUrl,
  buildCreditsPageUrl,
  parseCodexAdminIdentity,
  parseCreditDays,
  type CodexAdminIdentity,
} from "./credits";
import { estimatePaidCreditDays } from "./estimate";
import { readCurrentSnapshot } from "./usage";
import type { CreditSnapshot, MonitorSnapshot, RateLimitWindow } from "./types";

const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } = electron;
const appName = "Codex Monitor";
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const appIconPath = join(currentDirectory, "../assets/codex-monitor.png");
const codexDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const adminPartition = "persist:codex-monitor-admin";
const launchAgentLabel = "com.codex-monitor.widget";
const launchAgentPath = join(homedir(), "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
const usageRefreshMilliseconds = 2_000;
const liveUsageCacheMilliseconds = 15_000;
const creditsRefreshMilliseconds = 60_000;
const creditPriceUsd = 0.056;
const baseWidgetWidth = 340;
const fullWidgetHeight = 274;
const compactWidgetHeight = 204;
type Window = InstanceType<typeof BrowserWindow>;
type StatusTray = InstanceType<typeof Tray>;
interface Preferences {
  alwaysOnTop?: boolean;
  hideFromDock?: boolean;
  widgetWidth?: number;
}

let mainWindow: Window | undefined;
let adminWindow: Window | undefined;
let tray: StatusTray | undefined;
let usageSnapshot: MonitorSnapshot | undefined;
let usageRead: Promise<MonitorSnapshot | undefined> | undefined;
let usageReadAt = 0;
let creditSnapshot: CreditSnapshot | undefined;
let creditsRead: Promise<CreditSnapshot> | undefined;
let alwaysOnTop = true;
let hideFromDock = true;
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
  return baseWidgetWidth / (compactWidget ? compactWidgetHeight : fullWidgetHeight);
}

function setCompactWidget(compact: boolean): void {
  if (compactWidget === compact) return;
  compactWidget = compact;
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

async function loadPreferences(): Promise<void> {
  try {
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as Preferences;
    if (typeof stored.alwaysOnTop === "boolean") alwaysOnTop = stored.alwaysOnTop;
    if (typeof stored.hideFromDock === "boolean") hideFromDock = stored.hideFromDock;
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
  const preferences = { alwaysOnTop, hideFromDock, widgetWidth };
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

  adminWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    adminWindow?.hide();
  });

  adminWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await adminWindow.loadURL(buildCreditsPageUrl(identity));
  return adminWindow;
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

async function readCredits(): Promise<CreditSnapshot> {
  const identity = await readAdminIdentity();
  if (!identity) {
    return { status: "unavailable", days: [], message: "Codex login not found" };
  }

  try {
    const window = await getAdminWindow(identity);
    if (!isAdminPage(window)) {
      return { status: "auth_required", days: [] };
    }

    const dataUrl = buildCreditsDataUrl(identity);
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        try {
          const tenantKey = Object.keys(localStorage).find((key) =>
            key.startsWith("admin-portal:csr-active-tenant:"),
          );
          const tenantId = tenantKey ? localStorage.getItem(tenantKey) : null;
          if (!tenantId) {
            return { status: 403, contentType: "", payload: null };
          }
          const response = await fetch(${JSON.stringify(dataUrl)}, {
            credentials: "include",
            headers: {
              "accept": "application/json",
              "x-admin-portal-client": "csr",
              "x-admin-portal-tenant": tenantId,
              "x-admin-portal-user": ${JSON.stringify(identity.userId)},
              "x-admin-portal-workspace-id": ${JSON.stringify(identity.workspaceId)}
            }
          });
          const contentType = response.headers.get("content-type") || "";
          return {
            status: response.status,
            contentType,
            payload: contentType.includes("application/json") ? await response.json() : null
          };
        } catch (error) {
          return { status: 0, contentType: "", payload: null, message: String(error) };
        }
      })()
    `, true) as {
      status: number;
      contentType: string;
      payload: unknown;
      message?: string;
    };

    if (result.status === 401 || result.status === 403 || !result.contentType.includes("json")) {
      return { status: "auth_required", days: [] };
    }
    if (result.status !== 200) {
      return { status: "error", days: [], message: `Credits request failed (${result.status})` };
    }

    return {
      status: "ready",
      days: parseCreditDays(result.payload),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "error",
      days: [],
      message: error instanceof Error ? error.message : "Credits request failed",
    };
  }
}

async function connectCredits(): Promise<void> {
  const identity = await readAdminIdentity();
  if (!identity) return;
  const window = await getAdminWindow(identity);
  if (!isAdminCreditsPage(window, identity)) {
    await window.loadURL(buildCreditsPageUrl(identity));
  }
  window.show();
  window.focus();
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
  return usageSnapshot;
}

async function getLatestCredits(): Promise<CreditSnapshot> {
  creditsRead ??= readCreditSnapshot().finally(() => {
    creditsRead = undefined;
  });
  creditSnapshot = await creditsRead;
  updateTrayMenu();
  return creditSnapshot;
}

async function readCreditSnapshot(): Promise<CreditSnapshot> {
  const [adminResult, estimateResult] = await Promise.allSettled([
    readCredits(),
    estimatePaidCreditDays(codexDirectory),
  ]);
  const admin = adminResult.status === "fulfilled"
    ? adminResult.value
    : { status: "error" as const, days: [], message: "Admin credits request failed" };
  const estimatedDays = estimateResult.status === "fulfilled" ? estimateResult.value : [];

  if (admin.status === "ready") {
    return {
      ...admin,
      source: "admin",
      actualDays: admin.days,
      estimatedDays,
      adminStatus: "ready",
    };
  }
  if (estimatedDays.length) {
    return {
      status: "ready",
      source: "estimate",
      days: estimatedDays,
      estimatedDays,
      adminStatus: admin.status,
      updatedAt: new Date().toISOString(),
      message: admin.message,
    };
  }
  return admin;
}

async function refreshAll(): Promise<void> {
  await Promise.allSettled([getLatestUsage(true), getLatestCredits()]);
  mainWindow?.webContents.send("monitor:refresh");
}

function createTray(): void {
  const icon = nativeImage.createFromNamedImage("chart.xyaxis.line", {
    pointSize: 13,
    weight: "regular",
  }).resize({ width: 16, height: 16, quality: "best" });
  if (icon.isEmpty()) throw new Error("Could not create the menu-bar icon");
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(appName);
  updateTrayMenu();
}

function configureApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
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
  if (!tray) return;
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
  const startAtLogin = isStartAtLoginEnabled();

  tray.setContextMenu(Menu.buildFromTemplate([
    ...usageItems,
    { type: "separator" },
    { label: paidCredits, enabled: false },
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
  if (!snapshot) return "Paid credits today: loading…";
  if (snapshot.status !== "ready") return "Paid credits today: unavailable";
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
ipcMain.handle("credits:latest", getLatestCredits);
ipcMain.handle("credits:connect", connectCredits);
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
  setInterval(() => void getLatestUsage(), usageRefreshMilliseconds);
  setInterval(() => void getLatestCredits(), creditsRefreshMilliseconds);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", showWindow);
