import { describe, expect, it } from "bun:test";
import { readHeaderValue } from "../src/utils/snaptrade";

describe("readHeaderValue", () => {
  it("returns header values from plain objects", () => {
    const headers = {
      "x-request-id": "abc-123"
    };
    expect(readHeaderValue(headers, "x-request-id")).toBe("abc-123");
  });

  it("invokes header.get with the proper context", () => {
    const headers = {
      store: {
        "x-request-id": "req-456"
      },
      get(this: any, key: string) {
        const found = Object.keys(this.store).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
        return found ? this.store[found] : undefined;
      }
    };

    expect(readHeaderValue(headers, "X-Request-ID")).toBe("req-456");
  });

  it("falls back to undefined when no header matches", () => {
    const headers = {};
    expect(readHeaderValue(headers, "does-not-exist")).toBeUndefined();
  });
});
