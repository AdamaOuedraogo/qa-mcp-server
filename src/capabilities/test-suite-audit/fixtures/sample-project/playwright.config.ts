import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  retries: 3,
  reporter: "html",
  use: {
    baseURL: "https://shop.example.com",
    trace: "off",
  },
  projects: [{ name: "chromium" }],
});
