import { test, expect } from "@playwright/test";
import { CheckoutPage } from "../pages/checkout.page";

test("@p0 completes a purchase", async ({ page }) => {
  const checkout = new CheckoutPage(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByLabel("Email").fill("qa@example.com");
  await page.getByLabel("Password").fill("Sup3rSecret!");
  await checkout.pay();
  if (await page.locator(".modal").isVisible()) {
    await page.locator(".modal .close").click({ force: true });
  }
  await expect(page.getByText("Thank you")).toBeVisible();
});

test("navigates to the cart", async ({ page }) => {
  await page.goto("/cart");
  await page.locator("ul > li:nth-child(2)").click();
});
