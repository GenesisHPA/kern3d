// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    I18n,
    type IApplication,
    type INode,
    type IView,
    PubSub,
} from "@chili3d/core";
import { createIcon, div, span } from "@chili3d/element";
import { browserCategory } from "../project/browser/browserView";
import { menuRow } from "../toolbar/toolbarGroup";
import style from "./commandAccess.module.css";

/** The eight wedges, clockwise from the top; an unregistered command leaves its wedge empty. */
const DESIGN_WEDGES: readonly CommandKeys[] = [
    "special.last",
    "sketch.create",
    "feature.extrude",
    "feature.fillet",
    "modify.deleteNode",
    "modify.moveCopy",
    "edit.undo",
    "feature.pressPull",
];

const SKETCH_WEDGES: readonly CommandKeys[] = [
    "sketch.exit",
    "sketch.line",
    "sketch.circle",
    "sketch.rectangle",
    "sketch.trim",
    "dimension",
    "edit.undo",
    "special.last",
];

/** The context list under the wedges: what applies to the object that was clicked. */
const CONTEXT_COMMANDS: Record<string, readonly CommandKeys[]> = {
    body: [
        "feature.fillet",
        "feature.chamfer",
        "feature.shell",
        "modify.moveCopy",
        "modify.align",
        "modify.paintBucket",
        "inspect.massProperties",
        "modify.deleteNode",
    ],
    sketch: ["sketch.enter", "feature.extrude", "feature.revolve", "modify.deleteNode"],
    construction: ["sketch.create", "modify.deleteNode"],
    none: ["sketch.create", "file.import", "inspect.section", "edit.redo"],
};

/** Repeat is the command service's own key, not a registered command; it is always there. */
function isRunnable(command: CommandKeys): boolean {
    return command === "special.last" || CommandStore.getComandData(command) !== undefined;
}

const WEDGE_RADIUS = 92;
const DEAD_ZONE = 18;
const CLICK_SLOP = 5;

/** The wedge index (0 = top, clockwise) a pointer offset from the centre points at. */
export function wedgeAt(dx: number, dy: number): number | undefined {
    if (Math.hypot(dx, dy) < DEAD_ZONE) return undefined;
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 at the top, clockwise
    return Math.round(((angle + 360) % 360) / 45) % 8;
}

/**
 * The right-click menu of the canvas: eight command wedges around the pointer (repeat, sketch,
 * extrude, fillet…; the sketch tools while a sketch is open) and a list below for the object
 * under the pointer, which is selected first so the command acts on it. Moving toward a wedge
 * highlights it and a click runs it; Esc or a click in the centre closes the menu. It opens only
 * on a right click that did not drag and only while no command is running — a command keeps the
 * right button for itself.
 */
export class MarkingMenu {
    private overlay?: HTMLElement;
    private wedges: (HTMLElement | undefined)[] = [];
    private wedgeCommands: (CommandKeys | undefined)[] = [];
    private center = { x: 0, y: 0 };
    private highlighted: number | undefined;
    private press?: { x: number; y: number };

    constructor(
        readonly app: IApplication,
        readonly host: HTMLElement,
        readonly isSketchActive: () => boolean,
    ) {
        host.addEventListener("pointerdown", this.onHostDown);
        host.addEventListener("pointerup", this.onHostUp);
    }

    dispose() {
        this.close();
        this.host.removeEventListener("pointerdown", this.onHostDown);
        this.host.removeEventListener("pointerup", this.onHostUp);
    }

    get isOpen() {
        return this.overlay !== undefined;
    }

    private readonly onHostDown = (e: PointerEvent) => {
        if (e.button === 2) this.press = { x: e.clientX, y: e.clientY };
    };

    private readonly onHostUp = (e: PointerEvent) => {
        const press = this.press;
        this.press = undefined;
        if (e.button !== 2 || press === undefined) return;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP) return;
        if (this.app.executingCommand !== undefined) return;
        const view = this.app.activeView;
        if (view === undefined) return;
        this.open(e.clientX, e.clientY, this.nodeAt(view, e));
    };

    private nodeAt(view: IView, e: PointerEvent): INode | undefined {
        const rect = view.dom?.getBoundingClientRect();
        if (rect === undefined) return undefined;
        const detected = view.detectVisual(e.clientX - rect.left, e.clientY - rect.top);
        return detected.length ? view.document.visual.context.getNode(detected[0]) : undefined;
    }

    open(x: number, y: number, node: INode | undefined) {
        this.close();
        this.center = { x, y };
        if (node !== undefined) this.app.activeView?.document.selection.setSelectedNodes([node], false);
        const commands = this.isSketchActive() ? SKETCH_WEDGES : DESIGN_WEDGES;
        this.wedgeCommands = commands.map((c) => (isRunnable(c) ? c : undefined));
        const ring = div({ className: style.ring });
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        ring.append(div({ className: style.ringCenter, onclick: () => this.close() }));
        this.wedges = this.wedgeCommands.map((command, index) => {
            if (command === undefined) return undefined;
            const wedge = this.wedge(command, index);
            ring.append(wedge);
            return wedge;
        });
        this.overlay = div(
            { className: style.overlay, onpointerdown: this.onOverlayDown },
            ring,
            this.contextList(node, x, y),
        );
        this.overlay.addEventListener("pointermove", this.onOverlayMove);
        this.overlay.addEventListener("contextmenu", (e) => e.preventDefault());
        document.body.append(this.overlay);
        this.keepListOnScreen();
        window.addEventListener("keydown", this.onKeyDown, true);
    }

    /** Near the window's bottom the list goes above the wedges instead of off the screen. */
    private keepListOnScreen() {
        const list = this.overlay?.querySelector(`.${style.contextList}`) as HTMLElement | null;
        if (!list) return;
        const rect = list.getBoundingClientRect();
        if (rect.bottom <= window.innerHeight - 8) return;
        list.style.top = `${Math.max(8, this.center.y - WEDGE_RADIUS - 30 - rect.height)}px`;
    }

    close() {
        this.overlay?.remove();
        this.overlay = undefined;
        this.highlighted = undefined;
        window.removeEventListener("keydown", this.onKeyDown, true);
    }

    private wedge(command: CommandKeys, index: number) {
        const angle = (index * Math.PI) / 4;
        const icon = createIcon(this.iconOf(command));
        icon.classList.add(style.wedgeIcon);
        const wedge = div(
            {
                className: style.wedge,
                onclick: (e) => {
                    e.stopPropagation();
                    this.run(index);
                },
            },
            icon,
            span({ textContent: this.labelOf(command) }),
        );
        wedge.dataset["command"] = command;
        wedge.style.left = `${Math.sin(angle) * WEDGE_RADIUS}px`;
        wedge.style.top = `${-Math.cos(angle) * WEDGE_RADIUS}px`;
        // the side wedges hang off the ring's edge rather than straddling it
        const side = Math.sin(angle);
        wedge.style.transform = `translate(${side > 0.3 ? "-10%" : side < -0.3 ? "-90%" : "-50%"}, -50%)`;
        return wedge;
    }

    private iconOf(command: CommandKeys) {
        if (command === "special.last" && this.app.lastCommand) {
            return CommandStore.getComandData(this.app.lastCommand)?.icon ?? "icon-history";
        }
        return CommandStore.getComandData(command)?.icon ?? "icon-history";
    }

    private labelOf(command: CommandKeys): string {
        if (command !== "special.last") return I18n.translate(`command.${command}`);
        const last = this.app.lastCommand;
        return last
            ? I18n.translate("markingMenu.repeat{0}", I18n.translate(`command.${last}`))
            : I18n.translate("markingMenu.repeatNone");
    }

    private contextList(node: INode | undefined, x: number, y: number) {
        const category = node === undefined ? "none" : browserCategory(node);
        const commands = (CONTEXT_COMMANDS[category] ?? CONTEXT_COMMANDS["body"]).filter(
            (c) => CommandStore.getComandData(c) !== undefined,
        );
        const list = div({ className: style.contextList });
        list.style.left = `${x}px`;
        list.style.top = `${y + WEDGE_RADIUS + 30}px`;
        for (const command of commands) list.append(menuRow(command, () => this.close()));
        list.addEventListener("pointerdown", (e) => e.stopPropagation());
        if (commands.length === 0) list.style.display = "none";
        return list;
    }

    private readonly onOverlayMove = (e: PointerEvent) => {
        const index = wedgeAt(e.clientX - this.center.x, e.clientY - this.center.y);
        const target = index !== undefined && this.wedges[index] !== undefined ? index : undefined;
        if (target === this.highlighted) return;
        if (this.highlighted !== undefined) this.wedges[this.highlighted]?.classList.remove(style.hot);
        this.highlighted = target;
        if (target !== undefined) this.wedges[target]?.classList.add(style.hot);
    };

    /** A press anywhere outside the context list runs the highlighted wedge, or closes. */
    private readonly onOverlayDown = (e: PointerEvent) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest(`.${style.wedge}`)) return;
        if (this.highlighted !== undefined && e.button === 0) this.run(this.highlighted);
        else this.close();
    };

    private readonly onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        this.close();
    };

    private run(index: number) {
        const command = this.wedgeCommands[index];
        this.close();
        if (command !== undefined) PubSub.default.pub("executeCommand", command);
    }
}
