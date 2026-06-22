/**
 * Unit tests for the request-validation helpers (src/web/validate.ts).
 *
 * These exercise the helpers directly and through `handle()` so we assert the
 * exact failure envelope a route would emit — no database or network needed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { handle, HttpError } from "../../src/web/api.js";
import { parseBody, parseQuery } from "../../src/web/validate.js";
import { POST as sessionPost } from "../../app/api/auth/session/route.js";

function jsonReq(body: unknown): Request {
  return new Request("http://test/api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function malformedReq(): Request {
  return new Request("http://test/api", {
    method: "POST",
    body: "{ not valid json",
    headers: { "content-type": "application/json" },
  });
}

const NameSchema = z.object({ name: z.string().min(1).max(50) });

describe("parseBody", () => {
  it("returns parsed data for a valid body", async () => {
    const out = await parseBody(jsonReq({ name: "Hi" }), NameSchema);
    expect(out).toEqual({ name: "Hi" });
  });

  it("throws INVALID_BODY (400) for malformed JSON", async () => {
    await expect(parseBody(malformedReq(), NameSchema)).rejects.toMatchObject({
      code: "INVALID_BODY",
      status: 400,
    });
  });

  it("throws VALIDATION (400) for a schema violation", async () => {
    await expect(parseBody(jsonReq({ name: "" }), NameSchema)).rejects.toBeInstanceOf(HttpError);
    await expect(parseBody(jsonReq({ name: "" }), NameSchema)).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
    });
  });

  it("rejects an oversized field as VALIDATION", async () => {
    await expect(
      parseBody(jsonReq({ name: "x".repeat(51) }), NameSchema),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("produces the standard failure envelope through handle()", async () => {
    const res = await handle(async () => parseBody(jsonReq({}), NameSchema));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("VALIDATION");
    expect(typeof json.error.message).toBe("string");
  });

  it("passes a valid body through handle() as a success envelope", async () => {
    const res = await handle(async () => parseBody(jsonReq({ name: "ok" }), NameSchema));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { name: "ok" } });
  });
});

describe("parseQuery", () => {
  const Q = z.object({ teamId: z.coerce.number().int().positive() });

  it("coerces and returns valid query params", () => {
    expect(parseQuery(new URLSearchParams("teamId=5"), Q)).toEqual({ teamId: 5 });
  });

  it("throws VALIDATION for a non-numeric param", () => {
    expect(() => parseQuery(new URLSearchParams("teamId=abc"), Q)).toThrow(HttpError);
    try {
      parseQuery(new URLSearchParams("teamId=abc"), Q);
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION", status: 400 });
    }
  });

  it("throws VALIDATION for a missing required param", () => {
    try {
      parseQuery(new URLSearchParams(""), Q);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION", status: 400 });
    }
  });
});

describe("auth/session POST validation (route handler)", () => {
  it("returns a 400 INVALID_BODY envelope for malformed JSON", async () => {
    const res = await sessionPost(malformedReq());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
  });

  it("returns a 400 VALIDATION envelope when idToken is missing", async () => {
    const res = await sessionPost(jsonReq({}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("uses the custom message for an empty idToken", async () => {
    const res = await sessionPost(jsonReq({ idToken: "" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(json).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(json.error.message).toBe("missing idToken");
  });
});
