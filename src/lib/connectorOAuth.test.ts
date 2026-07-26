import { describe, expect, it } from "vitest";
import { parseConnectorOAuthCompletion } from "./connectorOAuth";

describe("parseConnectorOAuthCompletion", () => {
  it("accepts the fixed Aura connector completion route", () => {
    expect(
      parseConnectorOAuthCompletion(
        "aura://connectors/complete?attempt_id=abc&connector=gmail&outcome=success",
      ),
    ).toEqual({
      attemptId: "abc",
      connector: "gmail",
      outcome: "success",
    });
  });

  it("rejects external schemes and unknown connector values", () => {
    expect(
      parseConnectorOAuthCompletion(
        "https://evil.example/complete?attempt_id=abc&connector=gmail&outcome=success",
      ),
    ).toBeNull();
    expect(
      parseConnectorOAuthCompletion(
        "aura://connectors/complete?attempt_id=abc&connector=drive&outcome=success",
      ),
    ).toBeNull();
  });
});
