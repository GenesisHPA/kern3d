// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandData, CommandKeys, IApplication, ICommand, IView } from "@chili3d/core";
import { CommandStore, PubSub } from "@chili3d/core";
import { createMockApplication, createMockDocument } from "@chili3d/core/test-utils";
import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { CommandService } from "../../src/services/commandService";

let runs = 0;
let enabled = true;

class GatedCommand implements ICommand {
    async execute(): Promise<void> {
        runs++;
    }
}

const KEY = "test.gated" as CommandKeys;

describe("CommandService and a command a setting switches off", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(KEY);
        PubSub.default.removeAll("executeCommand");
        PubSub.default.removeAll("activeViewChanged");
        runs = 0;
        enabled = true;
    });

    function start(): { service: CommandService; app: IApplication } {
        CommandStore.registerCommand(GatedCommand, {
            key: KEY,
            icon: "test-icon",
            isEnabled: () => enabled,
        } as CommandData);
        const service = new CommandService();
        const app = createMockApplication();
        app.activeView = { document: createMockDocument({ id: "d", name: "d" }) } as unknown as IView;
        service.register(app);
        service.start();
        return { service, app };
    }

    test("runs while on", async () => {
        const { service, app } = start();
        PubSub.default.pub("executeCommand", KEY);
        await rs.waitFor(() => expect(app.lastCommand).toBe(KEY));
        expect(runs).toBe(1);
        service.stop();
    });

    test("off: refused with a toast, nothing runs", async () => {
        enabled = false;
        const { service } = start();
        const toasts: unknown[] = [];
        const pub = PubSub.default.pub.bind(PubSub.default);
        const spy = rs.spyOn(PubSub.default, "pub").mockImplementation(((
            name: string,
            ...args: unknown[]
        ) => {
            if (name === "showToast") toasts.push(args[0]);
            return (pub as (n: string, ...a: unknown[]) => void)(name, ...args);
        }) as never);
        try {
            PubSub.default.pub("executeCommand", KEY);
            await rs.waitFor(() => expect(toasts).toContain("toast.command.disabled"));
            expect(runs).toBe(0);
        } finally {
            spy.mockRestore();
            service.stop();
        }
    });

    test("CommandStore.isEnabled reads the gate; an unknown command is not enabled", () => {
        start().service.stop();
        expect(CommandStore.isEnabled(KEY)).toBe(true);
        enabled = false;
        expect(CommandStore.isEnabled(KEY)).toBe(false);
        expect(CommandStore.isEnabled("test.nothing")).toBe(false);
    });
});
