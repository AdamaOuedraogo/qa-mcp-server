import type { Page } from "@playwright/test";

export class CheckoutPage {
  constructor(private readonly page: Page) {}
  async pay() {
    await this.page.getByRole("button", { name: "Pay" }).click();
  }
}
