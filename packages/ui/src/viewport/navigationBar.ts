// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CAMERA_FLY_DURATION,
    I18n,
    type I18nKeys,
    type IView,
    PubSub,
    type ViewMode,
    ViewModeI18nKeys,
    ViewModes,
} from "@chili3d/core";
import { div, span, svg } from "@chili3d/element";
import { type GlyphName, glyph } from "../glyphs";
import style from "./navigationBar.module.css";

/** A navigation mode of the bar: while one is on, a left drag on the canvas moves the camera. */
export type NavigationMode = "orbit" | "pan" | "zoom";

const ROTATE_SCALE = 4;

/**
 * The bar at the bottom centre of the canvas: orbit / pan / zoom drag modes, fit, the display
 * mode, perspective or orthographic, the ground grid, and section analysis. A drag mode stays on
 * until its button is pressed again or Esc; it takes the left button over the canvas before the
 * view's own handlers see it, so selection and commands are untouched while it is off.
 */
export class NavigationBar extends HTMLElement {
    private mode: NavigationMode | undefined;
    private readonly modeButtons = new Map<NavigationMode, HTMLElement>();
    private readonly gridButton: HTMLElement;
    private readonly sectionButton: HTMLElement;
    private readonly cameraButton: HTMLElement;
    private readonly displayMenu = div({ className: style.popup });
    private last?: { x: number; y: number };

    constructor(readonly view: IView) {
        super();
        this.className = style.root;
        this.gridButton = this.button("grid", "navbar.grid", () => this.toggleGrid());
        this.sectionButton = this.button("section", "navbar.section", () => this.toggleSection());
        this.cameraButton = this.iconButton(
            view.cameraController.cameraType === "perspective" ? "icon-perspective" : "icon-orthographic",
            "navbar.camera",
            () => this.toggleCamera(),
        );
        const display = this.button("display", "navbar.displayMode", () => this.toggleDisplayMenu());
        display.append(this.displayMenu);
        this.append(
            this.modeButton("orbit"),
            this.modeButton("pan"),
            this.modeButton("zoom"),
            this.button("fit", "navbar.fit", () => this.fit()),
            div({ className: style.separator }),
            display,
            this.cameraButton,
            this.gridButton,
            this.sectionButton,
        );
        this.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.addEventListener("click", (e) => e.stopPropagation());
        this.addEventListener("pointerenter", () => this.refresh());
        this.refresh();
    }

    connectedCallback() {
        this.view.onPropertyChanged(this.onViewChanged);
        this.view.cameraController.onPropertyChanged?.(this.onCameraChanged);
    }

    disconnectedCallback() {
        this.view.removePropertyChanged(this.onViewChanged);
        this.view.cameraController.removePropertyChanged?.(this.onCameraChanged);
        this.closeDisplayMenu();
        this.setMode(undefined);
    }

    get activeMode() {
        return this.mode;
    }

    private readonly onViewChanged = (property: string) => {
        if (property === "showGrid" || property === "mode") this.refresh();
    };

    private readonly onCameraChanged = (property: string) => {
        if (property === "cameraType") this.refresh();
    };

    private button(name: GlyphName, tip: I18nKeys, onclick: () => void) {
        const element = div({ className: style.button, title: I18n.translate(tip), onclick });
        element.dataset["nav"] = name;
        element.append(glyph(name, style.glyph));
        return element;
    }

    private iconButton(icon: string, tip: I18nKeys, onclick: () => void) {
        const element = div({ className: style.button, title: I18n.translate(tip), onclick });
        element.dataset["nav"] = "camera";
        element.append(svg({ className: style.glyph, icon }));
        return element;
    }

    private modeButton(mode: NavigationMode) {
        const element = this.button(mode, `navbar.${mode}`, () => {
            this.setMode(this.mode === mode ? undefined : mode);
        });
        this.modeButtons.set(mode, element);
        return element;
    }

    refresh() {
        this.modeButtons.forEach((button, mode) => button.classList.toggle(style.active, mode === this.mode));
        this.gridButton.classList.toggle(style.active, this.view.showGrid === true);
        this.gridButton.style.display = this.view.showGrid === undefined ? "none" : "";
        this.sectionButton.classList.toggle(style.active, this.view.sectionPlane !== undefined);
        const perspective = this.view.cameraController.cameraType === "perspective";
        this.cameraButton.replaceChildren(
            svg({ className: style.glyph, icon: perspective ? "icon-perspective" : "icon-orthographic" }),
        );
    }

    setMode(mode: NavigationMode | undefined) {
        const host = this.view.dom;
        if (this.mode !== undefined && host) {
            host.removeEventListener("pointerdown", this.onCanvasDown, true);
            host.classList.remove(style.navigating);
            window.removeEventListener("keydown", this.onKeyDown, true);
        }
        this.mode = mode;
        if (mode !== undefined && host) {
            host.addEventListener("pointerdown", this.onCanvasDown, true);
            host.classList.add(style.navigating);
            window.addEventListener("keydown", this.onKeyDown, true);
        }
        this.refresh();
    }

    private readonly onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        this.setMode(undefined);
    };

    private readonly onCanvasDown = (e: PointerEvent) => {
        if (e.button !== 0 || this.contains(e.target as Node)) return;
        e.stopPropagation();
        e.preventDefault();
        this.last = { x: e.clientX, y: e.clientY };
        window.addEventListener("pointermove", this.onDrag, true);
        window.addEventListener("pointerup", this.onDragEnd, true);
    };

    private readonly onDrag = (e: PointerEvent) => {
        if (this.last === undefined) return;
        e.stopPropagation();
        const dx = e.clientX - this.last.x;
        const dy = e.clientY - this.last.y;
        this.last = { x: e.clientX, y: e.clientY };
        this.applyDrag(dx, dy);
    };

    private readonly onDragEnd = (e: PointerEvent) => {
        e.stopPropagation();
        this.last = undefined;
        window.removeEventListener("pointermove", this.onDrag, true);
        window.removeEventListener("pointerup", this.onDragEnd, true);
    };

    applyDrag(dx: number, dy: number) {
        const camera = this.view.cameraController;
        if (this.mode === "orbit") camera.rotate(dx * ROTATE_SCALE, dy * ROTATE_SCALE);
        else if (this.mode === "pan") camera.pan(dx, dy);
        else if (this.mode === "zoom" && dy !== 0) camera.zoom(this.view.width / 2, this.view.height / 2, dy);
        this.view.update();
    }

    private fit() {
        this.view.cameraController.fitContent({ duration: CAMERA_FLY_DURATION });
        this.view.update();
    }

    private toggleGrid() {
        if (this.view.showGrid === undefined) return;
        this.view.showGrid = !this.view.showGrid;
        this.view.update();
        this.refresh();
    }

    private toggleSection() {
        if (this.view.sectionPlane !== undefined) {
            this.view.setSectionPlane?.(undefined);
            this.view.update();
        } else {
            PubSub.default.pub("executeCommand", "inspect.section");
        }
        this.refresh();
    }

    private toggleCamera() {
        const camera = this.view.cameraController;
        camera.cameraType = camera.cameraType === "perspective" ? "orthographic" : "perspective";
        this.view.update();
        this.refresh();
    }

    private toggleDisplayMenu() {
        if (this.displayMenu.classList.contains(style.open)) {
            this.closeDisplayMenu();
            return;
        }
        this.displayMenu.replaceChildren(...ViewModes.map((mode) => this.displayRow(mode)));
        this.displayMenu.classList.add(style.open);
        document.addEventListener("pointerdown", this.onOutsideMenu, true);
    }

    private closeDisplayMenu() {
        this.displayMenu.classList.remove(style.open);
        document.removeEventListener("pointerdown", this.onOutsideMenu, true);
    }

    private readonly onOutsideMenu = (e: PointerEvent) => {
        if (!this.contains(e.target as Node)) this.closeDisplayMenu();
    };

    private displayRow(mode: ViewMode) {
        const row = div(
            {
                className: mode === this.view.mode ? `${style.popupRow} ${style.active}` : style.popupRow,
                onclick: (e) => {
                    e.stopPropagation();
                    this.view.mode = mode;
                    this.view.update();
                    this.closeDisplayMenu();
                },
            },
            span({ textContent: I18n.translate(ViewModeI18nKeys[mode]) }),
        );
        row.dataset["mode"] = mode;
        return row;
    }
}

customElements.define("chili-navigation-bar", NavigationBar);
