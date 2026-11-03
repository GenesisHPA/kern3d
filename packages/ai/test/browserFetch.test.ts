// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { fetchWithoutSdkHeaders } from "../src/llm/browserFetch";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("fetchWithoutSdkHeaders", () => {
    test("drops the SDK's x-stainless headers and keeps the rest", async () => {
        const sent: Headers[] = [];
        globalThis.fetch = rs.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            sent.push(new Headers(init?.headers));
            return new Response("{}");
        }) as unknown as typeof fetch;

        await fetchWithoutSdkHeaders("https://example.test/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: "Bearer k",
                "Content-Type": "application/json",
                "X-Stainless-OS": "Windows",
                "x-stainless-retry-count": "0",
            },
            body: "{}",
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].get("authorization")).toBe("Bearer k");
        expect(sent[0].get("content-type")).toBe("application/json");
        expect(Array.from(sent[0].keys()).filter((k) => k.startsWith("x-stainless"))).toEqual([]);
    });
});
