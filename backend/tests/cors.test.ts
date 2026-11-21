import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";

describe("CORS", () => {
  it("allows configured origins with credentials for preflight requests", async () => {
    const response = await request(app)
      .options("/api/v1/auth/refresh")
      .set("Origin", "https://frontend.example.test")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://frontend.example.test",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toContain("Origin");
  });

  it("rejects unconfigured origins without enabling CORS", async () => {
    const response = await request(app)
      .options("/api/v1/auth/refresh")
      .set("Origin", "https://untrusted.example.test")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CORS_ORIGIN_DENIED");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
