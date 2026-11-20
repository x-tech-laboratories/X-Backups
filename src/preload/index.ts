// The desktop page's bridge to the main process: the connection manager, its requests to the chosen daemon, the
// daemon's change stream and the trusted certificates.

import { contextBridge, ipcRenderer } from "electron";

import { certificate_bridge, portal_bridge, portal_events } from "../shared/desktop.ts";

portal_bridge.expose(contextBridge, ipcRenderer);
portal_events.expose(contextBridge, ipcRenderer);
certificate_bridge.expose(contextBridge, ipcRenderer);
