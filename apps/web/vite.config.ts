import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // `VITE_API_PROXY` lets a second dev instance (e.g. a demo) target another API port.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": env.VITE_API_PROXY ?? "http://localhost:3000",
      },
    },
  };
});
