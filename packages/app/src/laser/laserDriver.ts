// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Pt } from "./geometry";
import type { JobState } from "./grblController";
import type { LaserJobData } from "./laserData";
import type { LaserController, MachineProfile } from "./machineProfile";
import type { GrayImage } from "./raster";

/**
 * A laser controller as the machine tab and the editor's buttons see it, whatever board is
 * behind it: GRBL over a serial port today (`GrblDriver`), a JCZ / EzCAD galvo board over USB
 * next. A driver owns its connection, reports state through events, and takes the job in the
 * form it needs from `LaserProgram` — G-code lines for GRBL, the job itself for a galvo board.
 */

/** A board-neutral reading of the machine's state. */
export type DriverState = "offline" | "idle" | "run" | "hold" | "alarm" | "busy";

export interface DriverStatus {
    state: DriverState;
    /** The board's own word for it ("Idle", "Hold:0", …), shown as is. */
    label: string;
    /** Work and machine position, mm. */
    position?: Pt;
    machinePosition?: Pt;
    feed?: number;
    power?: number;
}

export type DriverEvent =
    | { type: "connection"; connected: boolean }
    | { type: "status"; status: DriverStatus }
    | { type: "log"; text: string; kind: "in" | "out" | "err" }
    | { type: "job"; state: JobState }
    | { type: "progress"; done: number; total: number }
    | { type: "framing"; active: boolean }
    /** Something the user must see at once (an alarm), already in their language. */
    | { type: "alert"; text: string };

/** Everything a driver may need to run a job; each takes what its board understands. */
export interface LaserProgram {
    job: LaserJobData;
    profile: MachineProfile;
    images: ReadonlyMap<string, GrayImage>;
    gcode: string[];
    seconds: number;
}

export interface DriverCapabilities {
    /** Free-form commands typed into the console. */
    console: boolean;
    /** $H / $X style homing and alarm unlock. */
    homing: boolean;
}

export interface LaserDriver {
    readonly kind: LaserController;
    readonly capabilities: DriverCapabilities;
    readonly connected: boolean;
    readonly status: DriverStatus;
    readonly jobState: JobState;
    readonly progress: { done: number; total: number };
    /** The red pointer is looping. */
    readonly framing: boolean;
    on(listener: (e: DriverEvent) => void): () => void;

    /** Asks the user for the device (the browser's chooser) and opens it. */
    connect(): Promise<void>;
    /** Laser off, then the device is let go. */
    disconnect(): Promise<void>;

    jog(dx: number, dy: number, feed: number): void;
    goToOrigin(): void;
    /** The head's present position becomes the job's X0 Y0. */
    setZero(): void;
    unlock(): void;
    home(): void;
    reset(): void;
    /** A console line; false when it was not sent (a job runs, or the board takes none). */
    command(line: string): boolean;

    /** Loops the red pointer (or the laser at pilot power) along `paths` until `stopFraming`. */
    startFraming(paths: Pt[][]): boolean;
    stopFraming(): void;

    /** Starts the job; false when it cannot start now. A loop of the pointer is stopped first. */
    run(program: LaserProgram): boolean;
    pause(): void;
    resume(): void;
    /** Stops at once: the rest is dropped and the laser goes off. */
    stop(): void;
}
