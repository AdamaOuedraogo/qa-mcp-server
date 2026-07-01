import { test, expect } from "@playwright/test";

/**
 * Sample Playwright test illustrating the conventions this project encourages:
 *  - accessible, role-based locators
 *  - web-first, auto-retrying assertions
 *  - no fixed sleeps
 *  - one independent user journey per test
 *
 * This file is an example only; it is excluded from the server build.
 */
test.describe("login", () => {
  test("logs in with valid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill("user@example.com");
    await page.getByLabel("Password").fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
  });

  test("shows an error for invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill("user@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toContainText(/invalid/i);
  });
});
