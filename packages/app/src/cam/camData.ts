// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type IDocument,
    Id,
    Node,
    NodeUtils,
    serializable,
    serialize,
    Transaction,
} from "@chili3d/core";
import { defaultMillMachine, type MillMachine, POST_KINDS } from "./camGcode";
import { type CamTool, defaultTools, parseTool } from "./camTools";
import type { Pt } from "./offset";
import type { Stock } from "./simulate";
import { type CamOperation, OPERATION_KINDS, PROFILE_SIDES } from "./toolpath";
import { defaultVfd, type VfdSettings } from "./vfd";

/** A milling job: the stock, the operations in order, the tools they use, the machine. */
export interface MillJob {
    version: 1;
    stock: Stock;
    operations: CamOperation[];
    tools: CamTool[];
    machine: MillMachine;
    vfd: VfdSettings & { enabled: boolean };
    /** Shapes brought in (SVG, the model): named outlines operations take their geometry from. */
    shapes: { id: string; name: string; rings: Pt[][]; points: Pt[] }[];
}

export function defaultMillJob(): MillJob {
    return {
        version: 1,
        stock: { minX: 0, minY: 0, width: 100, height: 100, top: 0, bottom: -10 },
        operations: [],
        tools: defaultTools(),
        machine: defaultMillMachine(),
        vfd: { ...defaultVfd(), enabled: false },
        shapes: [],
    };
}

function num(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function pts(raw: unknown): Pt[] {
    return Array.isArray(raw)
        ? raw.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).map((p) => ({ x: p.x, y: p.y }))
        : [];
}

export function parseOperation(raw: any): CamOperation | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const opt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return {
        id: typeof raw.id === "string" ? raw.id : Id.generate(),
        name: typeof raw.name === "string" ? raw.name : "",
        kind: OPERATION_KINDS.includes(raw.kind) ? raw.kind : "profile",
        toolId: typeof raw.toolId === "string" ? raw.toolId : "",
        depth: Math.max(0, num(raw.depth, 3)),
        stepDown: opt(raw.stepDown),
        stepOver: opt(raw.stepOver),
        feed: opt(raw.feed),
        plunge: opt(raw.plunge),
        rpm: opt(raw.rpm),
        side: PROFILE_SIDES.includes(raw.side) ? raw.side : "outside",
        climb: raw.climb !== false,
        ramp: raw.ramp === true,
        allowance: num(raw.allowance, 0),
        tabs: {
            count: Math.max(0, Math.round(num(raw.tabs?.count, 0))),
            width: num(raw.tabs?.width, 4),
            height: num(raw.tabs?.height, 1),
        },
        peck: Math.max(0, num(raw.peck, 0)),
        rings: Array.isArray(raw.rings) ? raw.rings.map(pts) : [],
        points: pts(raw.points),
        hidden: raw.hidden === true ? true : undefined,
        holeDiameter: opt(raw.holeDiameter),
        pitch: opt(raw.pitch),
        chamferWidth: opt(raw.chamferWidth),
        shapeId: typeof raw.shapeId === "string" ? raw.shapeId : undefined,
    } as CamOperation;
}

export function parseMillJob(json: string | undefined): MillJob {
    const base = defaultMillJob();
    if (json === undefined || json === "") return base;
    try {
        const raw = JSON.parse(json);
        const tools = Array.isArray(raw?.tools)
            ? raw.tools.map(parseTool).filter((t: CamTool | undefined) => t !== undefined)
            : base.tools;
        const m = raw?.machine ?? {};
        return {
            version: 1,
            stock: {
                minX: num(raw?.stock?.minX, 0),
                minY: num(raw?.stock?.minY, 0),
                width: Math.max(1, num(raw?.stock?.width, 100)),
                height: Math.max(1, num(raw?.stock?.height, 100)),
                top: 0,
                bottom: -Math.abs(num(raw?.stock?.bottom, -10)),
            },
            operations: Array.isArray(raw?.operations)
                ? raw.operations.map(parseOperation).filter((o: CamOperation | undefined) => o !== undefined)
                : [],
            tools,
            machine: {
                ...base.machine,
                toolChange: m.toolChange === "m6" ? "m6" : "pause",
                post: POST_KINDS.includes(m.post) ? m.post : "grbl",
                air: m.air === "m7" || m.air === "m8" ? m.air : "off",
                spindleDelay: num(m.spindleDelay, base.machine.spindleDelay),
                rapidFeed: num(m.rapidFeed, base.machine.rapidFeed),
                heights: {
                    safeZ: num(m.heights?.safeZ, base.machine.heights.safeZ),
                    clearance: num(m.heights?.clearance, base.machine.heights.clearance),
                },
                width: num(m.width, base.machine.width),
                depth: num(m.depth, base.machine.depth),
                height: num(m.height, base.machine.height),
                coolant: m.coolant === true,
            },
            vfd: { ...base.vfd, ...(typeof raw?.vfd === "object" ? raw.vfd : {}) },
            shapes: Array.isArray(raw?.shapes)
                ? raw.shapes.map((s: any) => ({
                      id: typeof s?.id === "string" ? s.id : Id.generate(),
                      name: typeof s?.name === "string" ? s.name : "",
                      rings: Array.isArray(s?.rings) ? s.rings.map(pts) : [],
                      points: pts(s?.points),
                  }))
                : [],
        };
    } catch {
        return base;
    }
}

/** A milling job in the document tree, as one JSON string (one undo step per edit). */
@serializable()
export class MillNode extends Node {
    get icon(): string {
        return "icon-layer-group";
    }

    constructor(options: { document: IDocument; name: string; id?: string; content?: string }) {
        super(options.document, options.name, options.id ?? Id.generate());
        this.setPrivateValue("content", options.content ?? JSON.stringify(defaultMillJob()));
    }

    @serialize()
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    get data(): MillJob {
        return parseMillJob(this.content);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function newMillJob(document: IDocument): MillNode {
    const name = NodeUtils.generateName(document, I18n.translate("mill.defaultName"));
    const node = new MillNode({ document, name });
    Transaction.execute(document, "mill.create", () => document.modelManager.addNode(node));
    return node;
}
