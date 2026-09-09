/**
 * Deterministic tests for the payout-check MVP:
 *   - classifyPayoutPage (login_required / ok / error)
 *   - DICloak request builders (exact guide-verified paths, string-only params)
 *   - global rate limiter spacing (max 1 request/second)
 *
 * Run:  packages/bot/node_modules/.bin/tsx --test src/payout.test.ts
 * (node:test runner — no new dependencies.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPayoutPage } from "./payout-classify.js";
import {
  DICLOAK_API_BASE,
  DICLOAK_MIN_INTERVAL_MS,
  buildCloseEnvRequest,
  buildListEnvsRequest,
  buildOpenEnvRequest,
  resetDicloakRateLimiterForTest,
  waitForDicloakSlot,
} from "./dicloak.js";

describe("classifyPayoutPage", () => {
  it("flags a login-redirect URL as login_required", () => {
    const out = classifyPayoutPage({
      finalUrl: "https://app.maloum.com/login?next=payout",
      title: "Log in",
      bodyText: "welcome",
    });
    assert.equal(out.verdict, "login_required");
    assert.equal(out.payoutHint, null);
  });

  it("flags login wording + password form as login_required", () => {
    const out = classifyPayoutPage({
      finalUrl: "https://app.maloum.com/payout",
      title: "Maloum",
      bodyText: "Please log in to continue\nEmail\n<input type=\"password\">",
    });
    assert.equal(out.verdict, "login_required");
  });

  it("reports ok with a short hint when payout-labeled text is present", () => {
    const out = classifyPayoutPage({
      finalUrl: "https://app.maloum.com/payout",
      title: "Payout — Maloum",
      bodyText: "Overview\nAvailable balance: see dashboard\nNext payout Friday",
    });
    assert.equal(out.verdict, "ok");
    assert.ok(out.payoutHint && out.payoutHint.length > 0);
  });

  it("reports ok without a hint when no payout text is identifiable", () => {
    const out = classifyPayoutPage({
      finalUrl: "https://app.maloum.com/payout",
      title: "Maloum",
      bodyText: "Hello\nDashboard loaded",
    });
    assert.equal(out.verdict, "ok");
    assert.equal(out.payoutHint, null);
  });

  it("reports error on block/error pages and unknown URLs", () => {
    assert.equal(
      classifyPayoutPage({
        finalUrl: "https://app.maloum.com/payout",
        title: "Maloum",
        bodyText: "Access denied",
      }).verdict,
      "error",
    );
    assert.equal(
      classifyPayoutPage({
        finalUrl: "https://example.com/somewhere",
        title: "Elsewhere",
        bodyText: "hello",
      }).verdict,
      "error",
    );
  });
});

describe("DICloak request builders", () => {
  it("uses the guide-verified base + endpoint paths", () => {
    assert.equal(DICLOAK_API_BASE, "http://127.0.0.1:52140/openapi");
    assert.equal(
      buildListEnvsRequest("1", "20").url,
      "http://127.0.0.1:52140/openapi/v1/env/list?page_no=1&page_size=20",
    );
    assert.equal(buildListEnvsRequest("1", "20").method, "GET");
    assert.equal(
      buildOpenEnvRequest("abc").url,
      "http://127.0.0.1:52140/openapi/v1/env/abc/open",
    );
    assert.equal(buildOpenEnvRequest("abc").method, "PATCH");
    assert.equal(
      buildCloseEnvRequest("abc").url,
      "http://127.0.0.1:52140/openapi/v1/env/abc/close",
    );
    assert.equal(buildCloseEnvRequest("abc").method, "PATCH");
  });

  it("carries no auth material in the built request", () => {
    for (const req of [
      buildListEnvsRequest("1", "20"),
      buildOpenEnvRequest("abc"),
      buildCloseEnvRequest("abc"),
    ]) {
      assert.ok(!JSON.stringify(req).toLowerCase().includes("api-key"));
    }
  });

  it("rejects non-string params instead of coercing them", () => {
    assert.throws(() => buildOpenEnvRequest(123), TypeError);
    assert.throws(() => buildOpenEnvRequest(""), TypeError);
    assert.throws(() => buildListEnvsRequest(1, "20"), TypeError);
    assert.throws(() => buildCloseEnvRequest(undefined), TypeError);
  });
});

describe("DICloak rate limiter", () => {
  it("spaces consecutive slots by at least the minimum interval", async () => {
    resetDicloakRateLimiterForTest();
    const t0 = Date.now();
    await waitForDicloakSlot();
    await waitForDicloakSlot();
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed >= DICLOAK_MIN_INTERVAL_MS - 50,
      `expected gap >= ${DICLOAK_MIN_INTERVAL_MS}ms, got ${elapsed}ms`,
    );
  });
});
