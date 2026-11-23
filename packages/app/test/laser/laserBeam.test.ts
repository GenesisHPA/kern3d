// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { BeamAnimation, type BeamProgress } from "../../src/laser/laserBeam";
import type { Move } from "../../src/laser/toolpath";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Three 10 mm burns along X at 600 mm/min (1 s each), a rapid between the second and third. */
function moves(): Move[] {
    const burn = (x0: number, x1: number): Move => ({
        x0,
        y0: 0,
        x1,
        y1: 0,
        rapid: false,
        power: 1000,
        feed: 600,
    });
    return [
        burn(0, 10),
        burn(10, 20),
        { x0: 20, y0: 0, x1: 20, y1: 5, rapid: true, power: 0, feed: 600 },
        burn(20, 30),
    ];
}

function setup() {
    const parent = document.createElementNS(SVG_NS, "g") as SVGGElement;
    const seen: BeamProgress[] = [];
    const beam = new BeamAnimation(parent, (p) => seen.push(p));
    const lit = () =>
        [...parent.querySelectorAll("path")]
            .map((p) => p.getAttribute("d") ?? "")
            .join("")
            .split("M").length - 1;
    const point = () => {
        const c = parent.querySelectorAll("circle")[1];
        return { x: Number(c.getAttribute("cx")), y: Number(c.getAttribute("cy")) };
    };
    return { parent, beam, seen, lit, point };
}

describe("laser beam animation", () => {
    test("GRBL: the point goes to the reported position and lights the moves before it", () => {
        const { beam, lit, point, seen } = setup();
        beam.start(moves(), 4, "position");
        beam.position({ x: 15, y: 0 });
        beam.pause(); // no running on by itself in the test
        (beam as unknown as { render(): void }).render();
        expect(point().x).toBeCloseTo(15, 3);
        // the first burn done, the second half done
        expect(lit()).toBe(2);
        expect(seen.at(-1)!.fraction).toBeGreaterThan(0.3);
        beam.dispose();
    });

    test("finish lights the whole burned path and hides the point", () => {
        const { parent, beam, lit } = setup();
        beam.start(moves(), 4, "time");
        beam.finish();
        expect(lit()).toBe(3); // the rapid is not lit
        expect(parent.querySelectorAll("circle")[1].getAttribute("display")).toBe("none");
        beam.dispose();
    });

    test("JCZ: never ahead of the lists the board has taken", () => {
        const { beam, seen } = setup();
        beam.start(moves(), 4, "time");
        beam.lists(1, 4);
        // a long time passes in one frame
        const b = beam as unknown as { lastFrame: number; tick(): void };
        b.lastFrame = performance.now() - 10_000;
        b.tick();
        expect(seen.at(-1)!.fraction).toBeCloseTo(0.25, 2);
        beam.dispose();
    });

    test("paused: the clock holds", () => {
        const { beam, seen } = setup();
        beam.start(moves(), 4, "time");
        beam.pause();
        const b = beam as unknown as { lastFrame: number; tick(): void };
        b.lastFrame = performance.now() - 2000;
        b.tick();
        expect(seen.at(-1)!.fraction).toBeCloseTo(0, 3);
        beam.dispose();
    });
});
