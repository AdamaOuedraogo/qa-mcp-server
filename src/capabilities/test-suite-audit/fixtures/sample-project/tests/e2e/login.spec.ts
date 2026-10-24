import { test, expect } from "@playwright/test";

test.describe("login", () => {
  test.only("logs in", async ({ page }) => {
    await page.goto("https://shop.example.com/login");
    await page.fill("#email", "qa@example.com");
    await page.fill("#password", "Sup3rSecret!");
    await page.click("//button[@type='submit']");
    await page.waitForTimeout(3000);
    await expect(page.locator("div > div > span")).toBeVisible();
  });

  test.skip("shows an error on bad password", async ({ page }) => {
    await page.goto("/login");
  });
});
