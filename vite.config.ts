import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        // Use a stable (non-hashed) filename for the main entry so the HTML
        // always references the same path across deploys. This eliminates the
        // "Importing a module script failed" stale-deploy error where old cached
        // HTML references a content-hashed chunk that no longer exists.
        // The file is served with no-cache headers (see vercel.json) so browsers
        // always revalidate it, while other chunks keep their content hashes.
        entryFileNames: 'assets/main.js',
      },
    },
  },
});
