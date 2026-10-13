import electron from "electron";
import type { CreditSnapshot, MonitorSnapshot } from "./types";

const { contextBridge, ipcRenderer } = electron;
contextBridge.exposeInMainWorld("codexMonitor", {
  latest: (): Promise<MonitorSnapshot | undefined> => ipcRenderer.invoke("usage:latest"),
  beginCreditLogin: (): Promise<void> => ipcRenderer.invoke("credits:begin-login"),
  dismissCreditIntroduction: (): void => ipcRenderer.send("credits:dismiss-introduction"),
  fitCreditIntroduction: (height: number): void => ipcRenderer.send("credits:fit-introduction", height),
  latestCredits: (): Promise<CreditSnapshot> => ipcRenderer.invoke("credits:latest"),
  onCreditsChanged: (callback: (snapshot: CreditSnapshot) => void): void => {
    ipcRenderer.on("credits:changed", (_event, snapshot: CreditSnapshot) => callback(snapshot));
  },
  automaticallyUseResets: (): Promise<boolean> => ipcRenderer.invoke("settings:auto-resets"),
  setAutomaticallyUseResets: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("settings:set-auto-resets", enabled),
  onAutomaticallyUseResetsChanged: (callback: (enabled: boolean) => void): void => {
    ipcRenderer.on("settings:auto-resets-changed", (_event, enabled: boolean) => callback(enabled));
  },
  hide: (): void => ipcRenderer.send("window:hide"),
  setCompact: (compact: boolean): void => ipcRenderer.send("window:set-compact", compact),
  onRefresh: (callback: () => void): void => {
    ipcRenderer.on("monitor:refresh", callback);
  },
});
