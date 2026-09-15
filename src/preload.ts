import electron from "electron";
import type { CreditSnapshot, MonitorSnapshot } from "./types";

const { contextBridge, ipcRenderer } = electron;
contextBridge.exposeInMainWorld("codexMonitor", {
  latest: (): Promise<MonitorSnapshot | undefined> => ipcRenderer.invoke("usage:latest"),
  latestCredits: (): Promise<CreditSnapshot> => ipcRenderer.invoke("credits:latest"),
  hide: (): void => ipcRenderer.send("window:hide"),
  setCompact: (compact: boolean): void => ipcRenderer.send("window:set-compact", compact),
  onRefresh: (callback: () => void): void => {
    ipcRenderer.on("monitor:refresh", callback);
  },
});
