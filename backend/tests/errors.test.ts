import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/shared/middleware/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error handler", () => {
  it("logs unexpected errors before returning an internal error response", async () => {
    const error = new Error("unexpected failure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.get("/", (_request, _response, next) => next(error));
    app.use(errorHandler);

    const response = await request(app).get("/");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "INTERNAL_ERROR",
      message: "Request failed",
    });
    expect(log).toHaveBeenCalledWith(
      "Unhandled request error",
      expect.objectContaining({
        method: "GET",
        path: "/",
        error,
      }),
    );
  });
});
