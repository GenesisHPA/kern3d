// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    Binding,
    CAMERA_FLY_DURATION,
    type IEventHandler,
    type IView,
    Localize,
    PubSub,
} from "@chili3d/core";
import { collection, div, input, label, span, svg } from "@chili3d/element";
import { Flyout } from "./flyout";
import { NavigationBar } from "./navigationBar";
import style from "./viewport.module.css";

export class Viewport extends HTMLElement {
    private readonly _flyout: Flyout;
    private readonly _eventCaches: [keyof HTMLElementEventMap, (e: any) => void][] = [];
    private readonly _acts: HTMLElement;

    constructor(
        readonly view: IView,
        readonly showViewControls: boolean,
    ) {
        super();
        this.className = style.root;
        this._flyout = new Flyout();
        this._acts = this.createActs();
        this.render();
        view.setDom(this);
    }

    private readonly onActCollectionChanged = () => {
        if (this.view.document.acts.length === 0) {
            this._acts.style.display = "none";
        } else {
            this._acts.style.display = "flex";
        }
    };

    private render() {
        this.append(this._acts, this.showViewControls ? new NavigationBar(this.view) : "");
    }

    private createActs() {
        return div(
            { className: style.actsContainer },
            div(
                {
                    className: style.border,
                    onpointerdown: (ev) => ev.stopPropagation(),
                    onclick: (e) => e.stopPropagation(),
                },
                collection({
                    className: style.acts,
                    sources: this.view.document.acts,
                    template: (v) => {
                        return div(
                            {
                                onclick: () => {
                                    this.view.cameraController.lookAt(
                                        v.cameraPosition,
                                        v.cameraTarget,
                                        v.cameraUp,
                                        { duration: CAMERA_FLY_DURATION },
                                    );
                                    this.view.update();
                                },
                            },
                            span({
                                textContent: new Binding(v, "name"),
                            }),
                            div(
                                {
                                    className: style.tools,
                                },
                                svg({
                                    icon: "icon-cog",
                                    onclick: () => this.setActName(v),
                                }),
                                svg({
                                    icon: "icon-times",
                                    onclick: () => {
                                        this.view.document.acts.remove(v);
                                    },
                                }),
                            ),
                        );
                    },
                    onwheel: (e) => {
                        e.preventDefault();
                        const container = e.currentTarget as HTMLElement;
                        container.scrollLeft += e.deltaY;
                    },
                }),
            ),
        );
    }

    private readonly setActName = (act: Act) => {
        const inputBox = input({
            value: act.name,
            onkeydown: (e) => {
                e.stopPropagation();
            },
        });
        PubSub.default.pub(
            "showDialog",
            "ribbon.group.act",
            div(label({ textContent: new Localize("common.name") }), ": ", inputBox),
            () => {
                act.name = inputBox.value;
            },
        );
    };

    connectedCallback() {
        this.initEvent();
        this.appendChild(this._flyout);
        this.view.document.acts.onCollectionChanged(this.onActCollectionChanged);
        this.onActCollectionChanged();
    }

    disconnectedCallback() {
        this.removeEvents();
        this._flyout.remove();
        this.view.document.acts.removeCollectionChanged(this.onActCollectionChanged);
    }

    dispose() {
        this.removeEvents();
    }

    private initEvent() {
        const events: [keyof HTMLElementEventMap, (e: any) => any][] = [
            ["pointerdown", this.pointerDown],
            ["pointermove", this.pointerMove],
            ["pointerout", this.pointerOut],
            ["pointerup", this.pointerUp],
            ["wheel", this.mouseWheel],
            ["dblclick", this.doubleClick],
        ];
        events.forEach((v) => {
            this.addEventListenerHandler(v[0], v[1]);
        });
    }

    private addEventListenerHandler(type: keyof HTMLElementEventMap, handler: (e: any) => any) {
        const listener = (e: any) => {
            e.preventDefault();
            this.pinPointerOffset(e);
            handler(e);
        };
        this.addEventListener(type, listener);
        this._eventCaches.push([type, listener]);
    }

    /**
     * Moves a pointer event's `offsetX/offsetY` onto the viewport's own frame.
     *
     * `offsetX/offsetY` are measured from the *target* element, and a target is not always
     * the canvas: a sketch constraint badge is a DOM overlay inside the viewport and takes
     * pointer events, so over one the offsets come back relative to the badge. Everything
     * the viewport dispatches to — the sketch's own handler, the drag handles — feeds them
     * to `view.rayAt`, which wants viewport coordinates; from a badge the ray would leave
     * from the wrong place, which is how a handle stops being grabbable and a drag jumps
     * mid-gesture. Correcting by the target's own position keeps every other frame intact,
     * including the overlays' own listeners, which are on their own elements and on the
     * window rather than here.
     */
    private pinPointerOffset(event: MouseEvent): void {
        const target = event.target as HTMLElement | null;
        if (target === null || target === this) return;
        const targetRect = target.getBoundingClientRect?.();
        if (targetRect === undefined) return;
        const rect = this.getBoundingClientRect();
        // the offset is measured from the padding edge, so the borders come off with it
        const dx = targetRect.left + (target.clientLeft ?? 0) - (rect.left + (this.clientLeft ?? 0));
        const dy = targetRect.top + (target.clientTop ?? 0) - (rect.top + (this.clientTop ?? 0));
        if (dx === 0 && dy === 0) return;
        Object.defineProperty(event, "offsetX", { value: event.offsetX + dx, configurable: true });
        Object.defineProperty(event, "offsetY", { value: event.offsetY + dy, configurable: true });
    }

    private removeEvents() {
        this._eventCaches.forEach((x) => {
            this.removeEventListener(x[0], x[1]);
        });
        this._eventCaches.length = 0;
    }

    private readonly handleEvent = (
        eventName: Exclude<keyof IEventHandler, "isEnabled" | "dispose">,
        event: PointerEvent | WheelEvent,
    ) => {
        if (this.view.document.visual.eventHandler.isEnabled)
            this.view.document.visual.eventHandler[eventName]?.(this.view, event as any);
        if (this.view.document.visual.viewHandler.isEnabled)
            this.view.document.visual.viewHandler[eventName]?.(this.view, event as any);
    };

    private readonly pointerMove = (event: PointerEvent) => {
        if (this._flyout) {
            this._flyout.style.top = `${event.offsetY}px`;
            this._flyout.style.left = `${event.offsetX}px`;
        }

        this.handleEvent("pointerMove", event);
    };

    private readonly pointerDown = (event: PointerEvent) => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }

        if (this.view.document.application.activeView !== this.view) {
            this.view.document.application.activeView = this.view;
        }

        this.handleEvent("pointerDown", event);
    };

    private readonly pointerUp = (event: PointerEvent) => {
        this.handleEvent("pointerUp", event);
    };

    private readonly pointerOut = (event: PointerEvent) => {
        this.handleEvent("pointerOut", event);
    };

    private readonly mouseWheel = (event: WheelEvent) => {
        this.handleEvent("mouseWheel", event);
    };

    /**
     * Lets feature packages react to a viewport double-click. A session that installed a
     * handler owning the gesture answers first — inside a sketch the double-click is the
     * sketch's business, and the node this would otherwise reach is the one already open — and
     * everything else falls through to the node, which is how a sketch is entered from the
     * viewport in the first place.
     */
    private readonly doubleClick = (event: MouseEvent) => {
        const handler = this.view.document.visual.eventHandler;
        if (handler.isEnabled && handler.doubleClick !== undefined) {
            handler.doubleClick(this.view, event);
            return;
        }
        const detected = this.view.detectVisual(event.offsetX, event.offsetY);
        const node = detected.length ? this.view.document.visual.context.getNode(detected[0]) : undefined;
        if (node === undefined) return;
        PubSub.default.pub("nodeDoubleClicked", node);
    };
}

customElements.define("chili-uiview", Viewport);
