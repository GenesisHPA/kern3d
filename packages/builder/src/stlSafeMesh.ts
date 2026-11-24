// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape } from "@chili3d/core";
import { type SafeTriangulator, trianglesOf } from "@chili3d/parametric";

/** What the triangulator needs of the kernel package (`@chili3d/wasm`, loaded lazily). */
interface SandboxKernel {
    KernelSandbox: {
        create(): Promise<{
            usable: boolean;
            count: number;
            run<T>(action: () => T): { ok: true; value: T } | { ok: false; crashed: boolean; error: string };
        }>;
    };
}

/** The sandbox is made anew after this many bodies: nothing frees its heap in between. */
const RENEW_AFTER = 40;

/**
 * Meshes the STL rebuild's bodies in a kernel of their own (see `safeMesh.ts` in parametric):
 * the body goes over as BREP text, its triangles come back as numbers, a crash there costs
 * only that kernel — made again before the next body.
 */
export class SandboxTriangulator implements SafeTriangulator {
    private box: Awaited<ReturnType<SandboxKernel["KernelSandbox"]["create"]>> | undefined;
    private making: Promise<void> | undefined;
    /** Bodies the sandbox could not mesh (for the diagnostics). */
    failures = 0;

    constructor(private readonly kernel: SandboxKernel) {}

    async ready(): Promise<void> {
        if (this.box?.usable && this.box.count < RENEW_AFTER) return;
        this.making ??= this.kernel.KernelSandbox.create()
            .then((box) => {
                this.box = box;
            })
            .finally(() => {
                this.making = undefined;
            });
        await this.making;
    }

    triangles(shape: IShape): Float64Array | undefined {
        const box = this.box;
        // not ready (a crash since the last `ready`): the body counts as not measurable
        if (box === undefined || !box.usable) {
            this.failures++;
            return undefined;
        }
        const brep = shapeConverter.convertToBrep(shape);
        if (!brep.isOk) {
            this.failures++;
            return undefined;
        }
        const result = box.run(() => {
            const copy = shapeConverter.convertFromBrep(brep.value);
            if (!copy.isOk) throw new Error(copy.error);
            try {
                return trianglesOf(copy.value);
            } finally {
                copy.value.dispose();
            }
        });
        if (!result.ok) {
            this.failures++;
            return undefined;
        }
        return result.value;
    }
}
