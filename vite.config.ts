import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@propsim/types": path.resolve(__dirname, "./src/vendor/types.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/@radix-ui/") ||
              id.includes("/@tanstack/") ||
              id.includes("/zustand/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("/lucide-react/")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
  server: {
    port: Number(env.OPENCHARTS_WEB_PORT ?? 5173),
    proxy: {
      "/api/forward-sim": {
        target: `http://127.0.0.1:${env.OPENCHARTS_FORWARD_PORT ?? 4001}`,
        changeOrigin: true,
      },
      "/api": {
        target: `http://127.0.0.1:${env.OPENCHARTS_AI_PORT ?? 3000}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${env.OPENCHARTS_AI_PORT ?? 3000}`,
        ws: true,
      },
    },
  },
  };
});
