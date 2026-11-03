// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type INode,
    type IShape,
    isPropertyChanged,
    Logger,
    type Matrix4,
    ParameterShapeNode,
    type ParameterShapeNodeOptions,
    Result,
    serialize,
} from "@chili3d/core";
import { syncNodeWatches } from "../nodeWatch";

/** Properties of a source whose change means the datum must re-resolve. */
const SOURCE_PROPERTIES = new Set([
    "shape",
    "transform",
    "plane",
    "definitionJson",
    "axisLine",
    "pointPosition",
]);

export interface DatumNodeOptions<D> extends ParameterShapeNodeOptions {
    definition?: D;
    /** Serialized form produced by the Serializer; takes precedence over `definition`. */
    definitionJson?: string;
}

/**
 * What a construction axis and a construction point share with `PlaneNode`: a JSON definition
 * that is the node's whole parametric content, the last resolved WORLD value kept (and saved)
 * as the fallback when a reference is lost, watches on every source node, and a tree warning
 * while the definition cannot resolve.
 *
 * Like the plane, the datum is world-authoritative — its drawing is built in the node's LOCAL
 * frame from the world value, so a node/parent transform never redefines it. It is a node
 * rather than a body feature for the plane's reason: it produces no solid.
 */
export abstract class DatumNode<D extends { readonly kind: string }, V> extends ParameterShapeNode {
    override get isReferenceGeometry(): boolean {
        return true;
    }

    override get copiesAsInstance(): boolean {
        return false;
    }

    @serialize()
    get definitionJson(): string {
        return this.getPrivateValue("definitionJson");
    }
    set definitionJson(value: string) {
        this.setPropertyEmitShapeChanged("definitionJson", value);
    }

    get definition(): D {
        try {
            const parsed: unknown = JSON.parse(this.definitionJson);
            if (parsed === null || typeof parsed !== "object") throw new Error("definition is not an object");
            return parsed as D;
        } catch (error) {
            Logger.warn(`${this.constructor.name}: definition is not valid JSON: ${String(error)}`);
            return this.defaultDefinition();
        }
    }

    /** Guards a watcher-driven rebuild against re-entering its own resolution. */
    private _resolving = false;
    /** Datum nodes already on the resolution stack when a lazy read had to trigger a build. */
    private _pendingVisited: ReadonlySet<string> | undefined;
    private _warningCount = 0;
    private readonly _sourceNodes = new Map<string, INode>();

    constructor(options: DatumNodeOptions<D>) {
        super(options);
        this.setPrivateValue(
            "definitionJson",
            options.definitionJson ?? JSON.stringify(options.definition ?? this.defaultDefinition()),
        );
        this.onPropertyChanged(this.handleSelfChanged);
    }

    protected abstract defaultDefinition(): D;
    protected abstract resolveDefinition(definition: D, visited: ReadonlySet<string>): Result<V>;
    protected abstract definitionNodeIds(definition: D): Set<string>;
    /** The drawing of `value` in the node's LOCAL frame (`toLocal` maps world into it). */
    protected abstract buildDisplay(value: V, toLocal: Matrix4): Result<IShape>;
    /** The persisted last value, and how it is written (without history). */
    protected abstract get storedValue(): V | undefined;
    protected abstract storeValue(value: V): void;
    protected abstract sameValue(left: V, right: V): boolean;

    /**
     * The datum in world coordinates, resolving it lazily the first time. `visited` is the
     * resolution stack: a cycle between datum nodes returns undefined instead of recursing.
     */
    protected worldValue(visited?: ReadonlySet<string>): V | undefined {
        if (visited?.has(this.id) === true) return undefined;
        if (!this._shape.isOk && !this._resolving) {
            const next = new Set(visited ?? []);
            next.add(this.id);
            this._pendingVisited = next;
            try {
                // Reading `shape` is what runs `generateShape` on a not-yet-resolved node.
                void this.shape;
            } finally {
                this._pendingVisited = undefined;
            }
        }
        return this.storedValue;
    }

    get warningCount(): number {
        return this._warningCount;
    }

    get warningTooltip(): I18nKeys {
        return "body.missingInputs{0}";
    }

    private setResolutionWarning(error: string | undefined): void {
        const count = error === undefined ? 0 : 1;
        if (count === this._warningCount) return;
        const previous = this._warningCount;
        this._warningCount = count;
        this.emitPropertyChanged("warningCount", previous);
        if (error !== undefined) Logger.warn(`${this.constructor.name}: ${error}`);
    }

    generateShape(): Result<IShape> {
        syncNodeWatches(
            this.document,
            this._sourceNodes,
            this.definitionNodeIds(this.definition),
            this.handleSourceChanged,
        );
        if (this._resolving) return this.displayOf(this.storedValue, "Datum is already resolving");
        this._resolving = true;
        try {
            const resolved = this.resolveDefinition(
                this.definition,
                this._pendingVisited ?? new Set([this.id]),
            );
            this.setResolutionWarning(resolved.isOk ? undefined : resolved.error);
            // A lost source keeps the last known value: the node stays visible and its users
            // keep resolving, with the warning badge saying why it no longer follows.
            const value = resolved.isOk ? resolved.value : this.storedValue;
            if (value === undefined) return this.displayOf(undefined, resolved.isOk ? "" : resolved.error);
            this.remember(value);
            return this.displayOf(value, "");
        } finally {
            this._resolving = false;
        }
    }

    private displayOf(value: V | undefined, error: string): Result<IShape> {
        const inverse = this.worldTransform().invert();
        if (value === undefined || inverse === undefined) {
            return Result.err(error || "Datum has no value");
        }
        return this.buildDisplay(value, inverse);
    }

    private remember(value: V): void {
        const previous = this.storedValue;
        if (previous !== undefined && this.sameValue(previous, value)) return;
        this.withoutHistory(() => this.storeValue(value));
    }

    /** A source changed: only a datum that actually MOVED rebuilds its drawing. */
    private refreshFromSources(): void {
        if (this._resolving || this._isDisposed) return;
        this._resolving = true;
        try {
            const resolved = this.resolveDefinition(this.definition, new Set([this.id]));
            this.setResolutionWarning(resolved.isOk ? undefined : resolved.error);
            if (!resolved.isOk) return;
            const previous = this.storedValue;
            if (previous !== undefined && this.sameValue(previous, resolved.value)) return;
            const inverse = this.worldTransform().invert();
            if (inverse === undefined) return;
            const display = this.buildDisplay(resolved.value, inverse);
            // The drawing goes first: a body caches its feature results against each source
            // node's `shape`, and it rebuilds on the value event — which must find the new one.
            this.withoutHistory(() => {
                this.setShape(display);
                this.storeValue(resolved.value);
            });
        } finally {
            this._resolving = false;
        }
    }

    private readonly handleSourceChanged = (property: string) => {
        if (SOURCE_PROPERTIES.has(property)) this.refreshFromSources();
    };

    /** The node's own placement changed: re-map the drawing onto the world datum. */
    private readonly handleSelfChanged = (property: keyof this) => {
        if (property !== "transform" || this._resolving) return;
        const value = this.storedValue;
        const inverse = this.worldTransform().invert();
        if (value === undefined || inverse === undefined) return;
        const display = this.buildDisplay(value, inverse);
        this.withoutHistory(() => this.setShape(display));
    };

    protected updateDefinition(update: (definition: D) => D): void {
        this.definitionJson = JSON.stringify(update(this.definition));
    }

    protected withoutHistory<T>(action: () => T): T {
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            return action();
        } finally {
            history.disabled = disabled;
        }
    }

    override disposeInternal(): void {
        this.removePropertyChanged(this.handleSelfChanged);
        for (const node of this._sourceNodes.values()) {
            if (isPropertyChanged(node)) node.removePropertyChanged(this.handleSourceChanged);
        }
        this._sourceNodes.clear();
        super.disposeInternal();
    }
}
