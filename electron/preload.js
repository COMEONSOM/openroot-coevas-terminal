import { contextBridge, ipcRenderer } from "electron";

console.log("✅ Preload script loaded");

contextBridge.exposeInMainWorld("electron", {
  openFolderDialog: async () => {
    return await ipcRenderer.invoke("open-folder-dialog");
  }
});