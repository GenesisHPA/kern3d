// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The message to show a user for a thrown value.
 *
 * Failures reach the UI in several shapes: an `Error`, a DOMException (not an `Error` in
 * every browser), a refused string — or the raw event an IndexedDB request rejects with,
 * whose own error sits on `target.error` and whose `String()` is just "[object Event]".
 */
export function errorText(error: unknown): string {
    const value = (error as { target?: { error?: unknown } } | undefined)?.target?.error ?? error;
    if (typeof value === "string") return value;

    const message = (value as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message.length > 0) return message;

    const name = (value as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.length > 0) return name;

    return String(value);
}

const KERNEL_CRASH =
    /^(RuntimeError: )?(Aborted\(|memory access out of bounds|unreachable|null function or function signature mismatch|index out of bounds|table index is out of bounds)/i;

/**
 * Whether a failure is the geometry kernel crashing: a wasm trap (`RuntimeError`: "memory access
 * out of bounds", "unreachable", "null function or function signature mismatch"…) or an
 * Emscripten abort, given as the thrown value or as its message. Either leaves the kernel's heap
 * in whatever state the crashed call left it, so every later call can fail in its own way — the
 * user has to hear that, not the trap's text.
 */
export function isKernelCrash(error: unknown): boolean {
    if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
    return KERNEL_CRASH.test(errorText(error));
}
