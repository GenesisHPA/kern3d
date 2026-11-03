// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `fetch` for the OpenAI SDK from the browser, without the SDK's `x-stainless-*` telemetry
 * headers. Every request from a page is preflighted with the headers it carries, and an endpoint
 * that allows only the standard ones (Google's Gemini OpenAI-compatible endpoint answers such a
 * preflight with 403) is then unreachable — the SDK reports it as a bare "Connection error".
 * The headers carry nothing the endpoints need.
 */
export const fetchWithoutSdkHeaders: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const key of Array.from(headers.keys())) {
        if (key.toLowerCase().startsWith("x-stainless-")) headers.delete(key);
    }
    return globalThis.fetch(input, { ...init, headers });
};
