// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, IView } from "@chili3d/core";
import { type I18nKeys, type IProgress, NoProgress, setProgressHost } from "@chili3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { afterEach, beforeEach, describe, expect, test } from "@rstest/core";
import { importFiles } from "../src/utils";

function createDocView(doc: IDocument): IView {
    return createMockView({
        document: doc,
        cameraController: { fitContent: () => {} },
    } as unknown as Partial<IView>);
}

describe("importFiles", () => {
    let newDocumentCalls: string[];
    /** What importFiles handed the progress window: the task (not run here) and its title. */
    let captured: { task: (progress: IProgress) => Promise<void>; title: I18nKeys } | undefined;

    beforeEach(() => {
        newDocumentCalls = [];
        captured = undefined;
        setProgressHost(async (task, title) => {
            captured = { task, title };
        });
    });

    afterEach(() => {
        setProgressHost(undefined);
    });

    describe("document resolution", () => {
        test("should use existing activeView document (does not call newDocument)", async () => {
            const doc = createMockDocument({ id: "existing", name: "existing" });
            const view = createDocView(doc);

            const app = createMockApplication({
                dataExchange: { import: async () => {} },
            });
            app.activeView = view;
            app.newDocument = async () => {
                newDocumentCalls.push("unexpected");
                return {} as IDocument;
            };

            await importFiles(app, [new File([], "test.step")]);

            expect(newDocumentCalls.length).toBe(0);
        });

        test("should create new Untitled document when no activeView", async () => {
            const app = createMockApplication({
                dataExchange: {
                    import: async (_document: IDocument, _files: File[] | FileList) => {},
                },
            });
            app.activeView = undefined;
            app.newDocument = async (name: string) => {
                newDocumentCalls.push(name);
                const newDoc = createMockDocument({ id: "new-doc", name, application: app });
                app.activeView = createDocView(newDoc);
                return newDoc;
            };

            await importFiles(app, [new File([], "test.igs")]);

            expect(newDocumentCalls).toEqual(["Untitled"]);
        });

        test("should create new document when activeView is undefined", async () => {
            const app = createMockApplication({
                dataExchange: { import: async () => {} },
            });
            app.activeView = undefined;
            app.newDocument = async (name: string) => {
                newDocumentCalls.push(name);
                const newDoc = createMockDocument({ id: "fallback-doc", name, application: app });
                app.activeView = createDocView(newDoc);
                return newDoc;
            };

            await importFiles(app, [new File([], "model.stl")]);

            expect(newDocumentCalls).toEqual(["Untitled"]);
        });
    });

    describe("progress window", () => {
        test("runs the import under the progress window titled with the import command", async () => {
            const doc = createMockDocument({ id: "test-doc", name: "test-doc" });
            const app = createMockApplication({
                dataExchange: { import: async () => {} },
            });
            app.activeView = createDocView(doc);
            app.newDocument = async () => ({}) as IDocument;

            await importFiles(app, [new File([], "test.stl")]);

            expect(captured?.title).toBe("command.file.import");
            expect(typeof captured?.task).toBe("function");
        });
    });

    describe("dataExchange integration", () => {
        test("the window's task imports the files with its progress and fits the view", async () => {
            let fitContentCalled = false;
            let importFilesArg: File[] | FileList | undefined;
            let importProgress: IProgress | undefined;

            const app = createMockApplication({
                dataExchange: {
                    import: async (_document: IDocument, files: File[] | FileList, progress?: IProgress) => {
                        importFilesArg = files;
                        importProgress = progress;
                    },
                },
            });
            app.newDocument = async () => ({}) as IDocument;

            const doc = createMockDocument({ id: "import-doc", name: "import-doc", application: app });
            app.activeView = createMockView({
                document: doc,
                cameraController: {
                    fitContent: () => {
                        fitContentCalled = true;
                    },
                },
            } as unknown as Partial<IView>);

            const files = [new File([], "model.brep")];
            await importFiles(app, files);

            expect(captured).not.toBeUndefined();
            await captured!.task(NoProgress);

            expect(importFilesArg).toBe(files);
            expect(importProgress).toBe(NoProgress);
            expect(fitContentCalled).toBe(true);
        });
    });
});
