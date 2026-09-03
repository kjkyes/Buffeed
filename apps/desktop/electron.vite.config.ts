import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@agentcore/contracts": path.resolve(__dirname, "../../packages/contracts"),
      },
    },
  },
});
