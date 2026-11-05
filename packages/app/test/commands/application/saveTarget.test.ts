// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DOCUMENT_FILE_EXTENSION, PubSub } from "@chili3d/core";
import { createMockApplication, createMockDocument } from "@chili3d/core/test-utils";
import { describe, expect, test } from "@rstest/core";
import { askSaveTarget, cleanFileName } from "../../../src/commands/application/saveTarget";
import { SaveDocumentToFile } from "../../../src/commands/application/toFile";

type Button = { content: string; onclick?: () => void };

/** Replaces PubSub for one test: answers the name dialog by typing `typed` and pressing `button`. */
function withDialog(typed: string | undefined, button: "common.confirm" | "common.cancel") {
    const seen: string[] = [];
    const original = PubSub.default.pub;
    PubSub.default.pub = ((channel: string, ...args: any[]) => {
        seen.push(channel);
        if (channel !== "showDialog") return;
        const field = (args[1] as HTMLElement).querySelector("input");
        expect(field).not.toBeNull();
        if (typed !== undefined) field!.value = typed;
        (args[2] as Button[]).find((b) => b.content === button)!.onclick?.();
    }) as any;
    return { seen, restore: () => (PubSub.default.pub = original) };
}

describe("cleanFileName", () => {
    test.each([
        ["detail", "detail"],
        ["  bracket v2  ", "bracket v2"],
        [`part${DOCUMENT_FILE_EXTENSION}`, "part"],
        ['a/b\\c:d*e?f"g<h>i|j', "a_b_c_d_e_f_g_h_i_j"],
        ["   ", "fallback"],
    ])("%j -> %j", (input, expected) => {
        expect(cleanFileName(input, "fallback")).toBe(expected);
    });
});

describe("askSaveTarget (in-app dialog)", () => {
    test("offers the current name and returns what the user typed", async () => {
        let offered = "";
        const original = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ...args: any[]) => {
            if (channel !== "showDialog") return;
            const field = (args[1] as HTMLElement).querySelector("input")!;
            offered = field.value;
            field.value = "New name";
            (args[2] as Button[])[0].onclick?.();
        }) as any;
        try {
            const target = await askSaveTarget("Document 1");
            expect(offered).toBe("Document 1");
            expect(target?.name).toBe("New name");
        } finally {
            PubSub.default.pub = original;
        }
    });

    test("resolves undefined on cancel", async () => {
        const { restore } = withDialog("ignored", "common.cancel");
        try {
            await expect(askSaveTarget("Document 1")).resolves.toBeUndefined();
        } finally {
            restore();
        }
    });
});

describe("askSaveTarget (system dialog)", () => {
    test("writes through the file handle the picker returns", async () => {
        const written: string[] = [];
        let suggested = "";
        const g = globalThis as any;
        const original = g.showSaveFilePicker;
        g.showSaveFilePicker = async (options: { suggestedName: string }) => {
            suggested = options.suggestedName;
            return {
                name: `Chosen${DOCUMENT_FILE_EXTENSION}`,
                createWritable: async () => ({
                    write: async (data: string) => {
                        written.push(data);
                    },
                    close: async () => {},
                }),
            };
        };
        try {
            const target = await askSaveTarget("Document 1");
            expect(suggested).toBe(`Document 1${DOCUMENT_FILE_EXTENSION}`);
            expect(target?.name).toBe("Chosen");
            await target!.write("{}");
            expect(written).toEqual(["{}"]);
        } finally {
            g.showSaveFilePicker = original;
        }
    });

    test("treats closing the system dialog as cancel", async () => {
        const g = globalThis as any;
        const original = g.showSaveFilePicker;
        g.showSaveFilePicker = async () => {
            throw new DOMException("closed", "AbortError");
        };
        try {
            await expect(askSaveTarget("Document 1")).resolves.toBeUndefined();
        } finally {
            g.showSaveFilePicker = original;
        }
    });
});

describe("SaveDocumentToFile name prompt", () => {
    test("cancel saves nothing and keeps the name", async () => {
        const { seen, restore } = withDialog("Other", "common.cancel");
        try {
            const doc = createMockDocument({ name: "Document 1" });
            const app = createMockApplication();
            app.activeView = { document: doc } as any;

            await new SaveDocumentToFile().execute(app);

            expect(seen).toContain("showDialog");
            expect(seen).not.toContain("showPermanent");
            expect(doc.name).toBe("Document 1");
        } finally {
            restore();
        }
    });

    test("a new name renames the document before saving", async () => {
        const { seen, restore } = withDialog("Bracket", "common.confirm");
        try {
            const doc = createMockDocument({ name: "Document 1" });
            const app = createMockApplication();
            app.activeView = { document: doc } as any;

            await new SaveDocumentToFile().execute(app);

            expect(doc.name).toBe("Bracket");
            expect(seen).toContain("showPermanent");
        } finally {
            restore();
        }
    });
});
