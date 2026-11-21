// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { decodeCorrection, encodeCorrection, JczDriver, type LmcTransport } from "../../src/laser/jczDriver";
import { defaultOperation, type LaserJobData } from "../../src/laser/laserData";
import type { DriverEvent, LaserProgram } from "../../src/laser/laserDriver";
import { Cmd, List, LMC_LIST_SIZE, STATUS_BUSY, STATUS_READY } from "../../src/laser/lmc";
import { defaultMachineProfile, type MachineProfile } from "../../src/laser/machineProfile";

/**
 * A pretend LMC board: answers every single command with a status word, keeps the list
 * packets it was sent, reports busy for a few polls after a list is executed, and can be told
 * to stop reporting ready (a full list buffer).
 */
class FakeBoard implements LmcTransport {
    readonly commands: number[][] = [];
    readonly lists: Uint8Array[] = [];
    ready = true;
    busyPolls = 0;
    closed = false;
    private reply = new Uint8Array(8);

    async write(bytes: Uint8Array) {
        if (bytes.length === LMC_LIST_SIZE) {
            this.lists.push(bytes.slice());
            return;
        }
        const words = Array.from({ length: 6 }, (_, i) => bytes[2 * i] | (bytes[2 * i + 1] << 8));
        this.commands.push(words);
        if (words[0] === Cmd.ExecuteList) this.busyPolls = 3;
        let status = this.ready ? STATUS_READY : 0;
        if (words[0] === Cmd.GetVersion && this.busyPolls > 0) {
            this.busyPolls--;
            status |= STATUS_BUSY;
        }
        this.reply = new Uint8Array([1, 0, 2, 0, 3, 0, status, 0]);
    }

    async read() {
        return this.reply;
    }

    async close() {
        this.closed = true;
    }

    ops(): number[] {
        return this.commands.map((c) => c[0]).filter((op) => op !== Cmd.GetVersion);
    }

    /** The list commands in every packet sent, end-of-list padding left out. */
    listOps(): number[][] {
        const out: number[][] = [];
        for (const p of this.lists) {
            for (let i = 0; i < p.length; i += 12) {
                const words = Array.from({ length: 6 }, (_, k) => p[i + 2 * k] | (p[i + 2 * k + 1] << 8));
                if (words[0] !== List.EndOfList) out.push(words);
            }
        }
        return out;
    }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function galvo(): MachineProfile {
    const p = defaultMachineProfile();
    return {
        ...p,
        controller: "jcz",
        origin: "center",
        bedWidth: 150,
        bedHeight: 150,
        jcz: { ...p.jcz, field: 150 },
    };
}

async function connected() {
    const board = new FakeBoard();
    const profile = galvo();
    const driver = new JczDriver(
        () => profile,
        async () => board,
        { sleep: tick, every: () => () => {} },
    );
    const events: DriverEvent[] = [];
    driver.on((e) => events.push(e));
    await driver.connect();
    return { board, driver, events, profile };
}

function untilJob(events: DriverEvent[], state: string) {
    return new Promise<void>((resolve, reject) => {
        let n = 0;
        const check = () => {
            if (events.some((e) => e.type === "job" && e.state === state)) resolve();
            else if (n++ > 2000) reject(new Error(`no job state ${state}`));
            else setTimeout(check, 0);
        };
        check();
    });
}

function squareJob(): LaserProgram {
    const job: LaserJobData = {
        version: 1,
        origin: "center",
        objects: [
            {
                id: "sq",
                name: "sq",
                kind: "vector",
                x: -5,
                y: -5,
                width: 10,
                height: 10,
                angle: 0,
                lockAspect: true,
                sourceWidth: 10,
                sourceHeight: 10,
                paths: [
                    {
                        closed: true,
                        points: [
                            { x: 0, y: 0 },
                            { x: 10, y: 0 },
                            { x: 10, y: 10 },
                            { x: 0, y: 10 },
                        ],
                    },
                ],
                op: { ...defaultOperation("line"), speed: 60000 },
            },
        ],
    };
    return { job, profile: galvo(), images: new Map(), gcode: [], seconds: 0 };
}

describe("JCZ driver on a fake board", () => {
    test("connecting runs the reference's start-up sequence with a blank correction", async () => {
        const { board, driver, events } = await connected();
        expect(driver.connected).toBe(true);
        expect(board.commands[0][0]).toBe(Cmd.GetSerialNo);
        expect(board.ops().slice(1, 9)).toEqual([
            Cmd.Reset,
            Cmd.WriteCorTable,
            Cmd.EnableLaser,
            Cmd.SetControlMode,
            Cmd.SetLaserMode,
            Cmd.SetDelayMode,
            Cmd.SetTiming,
            Cmd.SetStandby,
        ]);
        expect(board.commands.find((c) => c[0] === Cmd.WriteCorTable)?.[1]).toBe(0);
        expect(board.commands.find((c) => c[0] === Cmd.SetFpkParam2)?.slice(1, 5)).toEqual([
            0xffb, 1, 409, 100,
        ]);
        expect(events).toContainEqual({ type: "connection", connected: true });
    });

    test("a job: program mode, the list, execute, wait until idle, MO closed and laser off", async () => {
        const { board, driver, events } = await connected();
        const before = board.ops().length;
        expect(driver.run(squareJob())).toBe(true);
        await untilJob(events, "done");
        const ops = board.ops().slice(before);
        expect(ops.slice(0, 3)).toEqual([Cmd.ResetList, Cmd.WritePort, Cmd.FiberSetMo]);
        expect(ops.slice(3, 5)).toEqual([Cmd.SetEndOfList, Cmd.ExecuteList]);
        expect(ops.slice(-2)).toEqual([Cmd.FiberSetMo, Cmd.WritePort]);
        expect(board.lists).toHaveLength(1);
        const list = board.listOps();
        expect(list[0][0]).toBe(List.ReadyMark);
        expect(list.filter((c) => c[0] === List.MarkTo)).toHaveLength(4);
        expect(events).toContainEqual({ type: "progress", done: 1, total: 1 });
        // the board reported busy after the execute, and the driver waited it out
        expect(board.busyPolls).toBe(0);
    });

    test("stop while the board's list buffer is full: the reference's abort, laser off", async () => {
        const { board, driver, events } = await connected();
        board.ready = false;
        driver.run(squareJob());
        await tick();
        await tick();
        const before = board.ops().length;
        driver.stop();
        await untilJob(events, "stopped");
        expect(board.ops().slice(before)).toEqual([
            Cmd.StopExecute,
            Cmd.FiberSetMo,
            Cmd.ResetList,
            Cmd.SetEndOfList,
            Cmd.ExecuteList,
            Cmd.FiberSetMo,
            Cmd.WritePort,
        ]);
        expect(board.lists).toHaveLength(1);
        expect(board.commands[board.commands.length - 1].slice(0, 2)).toEqual([Cmd.WritePort, 0]);
    });

    test("the red pointer loops in light-mode lists until stopped: light port, jumps, never a mark", async () => {
        const { board, driver } = await connected();
        const box = [
            [
                { x: -10, y: -10 },
                { x: 10, y: -10 },
                { x: 10, y: 10 },
                { x: -10, y: -10 },
            ],
        ];
        expect(driver.startFraming(box)).toBe(true);
        for (let i = 0; i < 20 && board.lists.length < 4; i++) await tick();
        expect(board.lists.length).toBeGreaterThanOrEqual(4);
        expect(board.ops()).toContain(Cmd.ExecuteList);
        const list = board.listOps();
        expect(list.some((c) => c[0] === List.WritePort && c[1] === 1 << 8)).toBe(true);
        expect(list.some((c) => c[0] === List.MarkTo)).toBe(false);
        driver.stopFraming();
        for (let i = 0; i < 50 && driver.framing; i++) await tick();
        for (let i = 0; i < 50 && board.commands[board.commands.length - 1][0] !== Cmd.WritePort; i++)
            await tick();
        expect(driver.framing).toBe(false);
        expect(board.commands[board.commands.length - 1].slice(0, 2)).toEqual([Cmd.WritePort, 0]);
    });

    test("a board that cannot be opened leaves the driver disconnected", async () => {
        const driver = new JczDriver(galvo, async () => {
            throw new Error("Access denied");
        });
        await expect(driver.connect()).rejects.toThrow("Access denied");
        expect(driver.connected).toBe(false);
    });

    test("a correction table survives the profile's storage", () => {
        const table = Array.from({ length: 65 * 65 }, (_, i): [number, number] => [
            i & 0xffff,
            (i * 7) & 0xffff,
        ]);
        expect(decodeCorrection(encodeCorrection(table))).toEqual(table);
        expect(decodeCorrection("")).toBeUndefined();
    });
});
