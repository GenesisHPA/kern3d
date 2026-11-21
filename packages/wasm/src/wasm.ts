// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { errorText, isKernelCrash } from "@chili3d/core";
import MainModuleFactory, { type MainModule } from "../lib/chili-wasm";

declare global {
    var wasm: MainModule;
}

export interface InitWasmOptions {
    /**
     * Raw bytes of `chili-wasm.wasm`. Required when running under Node (e.g. the
     * MCP server or integration tests), where the Emscripten glue cannot `fetch`
     * the binary. Omit in the browser — Emscripten loads the `.wasm` itself.
     */
    wasmBinary?: BufferSource;
}

/** What the shared kernel was started with, so a sandbox kernel can start the same way. */
let initOptions: InitWasmOptions | undefined;

function createModule(options: InitWasmOptions | undefined): Promise<MainModule> {
    return MainModuleFactory(options?.wasmBinary ? { wasmBinary: options.wasmBinary } : undefined);
}

export async function initWasm(options?: InitWasmOptions) {
    initOptions = options;
    global.wasm = await createModule(options);
    return global.wasm;
}

/**
 * The outcome of a sandboxed run: its value, or the reason it failed and whether the reason
 * was a kernel crash (the sandbox is thrown away either way, so a crash costs nothing more).
 */
export type SandboxResult<T> = { ok: true; value: T } | { ok: false; crashed: boolean; error: string };

/**
 * Runs `action` against a FRESH kernel instance of its own, never the shared one: everything in
 * the wrappers reaches the kernel through the `wasm` global at call time, so swapping that global
 * for the length of a synchronous `action` puts every shape it makes in the sandbox's heap. The
 * shared kernel — every shape the open documents hold — is not touched, so a trap inside OCCT
 * (a malformed STL, a mesh it runs out of memory on) is the sandbox's loss alone; it is dropped
 * afterwards whatever happened, and its memory with it.
 *
 * `action` must be synchronous and must hand back plain data (text, numbers, arrays), never a
 * kernel object: a shape of the sandbox read through the shared kernel's bindings is garbage.
 * Hand a shape across as BREP text (`Converter.convertToBrep` inside, `convertFromBrep` outside).
 */
export async function runInSandboxKernel<T>(action: () => T): Promise<SandboxResult<T>> {
    let sandbox: MainModule;
    try {
        sandbox = await createModule(initOptions);
    } catch (error) {
        return { ok: false, crashed: false, error: errorText(error) };
    }
    const shared = global.wasm;
    global.wasm = sandbox;
    try {
        return { ok: true, value: action() };
    } catch (error) {
        return {
            ok: false,
            crashed: isKernelCrash(error),
            error: errorText(error),
        };
    } finally {
        global.wasm = shared;
    }
}
