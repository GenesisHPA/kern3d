// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, Matrix4, XYZ, type XYZLike } from "@chili3d/core";

/**
 * The joint kinds, Fusion's set. Each one leaves component 2 some degrees of freedom relative to
 * component 1, all measured in joint origin 1's frame (Z = the joint axis):
 *
 * - `rigid` — none.
 * - `revolute` — rotation about Z.
 * - `slider` — translation along Z.
 * - `cylindrical` — rotation about Z and translation along it.
 * - `pinSlot` — rotation about Z and translation along X.
 * - `planar` — translation in the XY plane and rotation about Z.
 * - `ball` — rotation about Z, then Y (yaw), then X (pitch).
 */
export type JointType = "rigid" | "revolute" | "slider" | "cylindrical" | "pinSlot" | "planar" | "ball";

export const JOINT_TYPES: readonly JointType[] = [
    "rigid",
    "revolute",
    "slider",
    "cylindrical",
    "pinSlot",
    "planar",
    "ball",
];

export const JOINT_TYPE_KEYS: Record<JointType, I18nKeys> = {
    rigid: "assembly.joint.type.rigid",
    revolute: "assembly.joint.type.revolute",
    slider: "assembly.joint.type.slider",
    cylindrical: "assembly.joint.type.cylindrical",
    pinSlot: "assembly.joint.type.pinSlot",
    planar: "assembly.joint.type.planar",
    ball: "assembly.joint.type.ball",
};

export function jointTypeOfKey(key: I18nKeys): JointType | undefined {
    return JOINT_TYPES.find((type) => JOINT_TYPE_KEYS[type] === key);
}

/** Which degrees of freedom a joint type has. */
export interface JointDofs {
    /** Rotation about Z (the revolute/cylindrical/pin-slot/planar angle, a ball's roll). */
    readonly rotation: boolean;
    /** The main translation: along Z (slider, cylindrical), along X (pin-slot, planar). */
    readonly slide: boolean;
    /** A planar joint's translation along Y. */
    readonly slide2: boolean;
    /** A ball's pitch (about X) and yaw (about Y). */
    readonly ball: boolean;
}

const DOFS: Record<JointType, JointDofs> = {
    rigid: { rotation: false, slide: false, slide2: false, ball: false },
    revolute: { rotation: true, slide: false, slide2: false, ball: false },
    slider: { rotation: false, slide: true, slide2: false, ball: false },
    cylindrical: { rotation: true, slide: true, slide2: false, ball: false },
    pinSlot: { rotation: true, slide: true, slide2: false, ball: false },
    planar: { rotation: true, slide: true, slide2: true, ball: false },
    ball: { rotation: true, slide: false, slide2: false, ball: true },
};

export function jointDofs(type: JointType): JointDofs {
    return DOFS[type] ?? DOFS.rigid;
}

/** A motion limit; `min`/`max` in degrees for a rotation, millimetres for a translation. */
export interface JointLimit {
    readonly enabled: boolean;
    readonly min: number;
    readonly max: number;
}

/** `value` held inside `limit` when it is enabled; a reversed range is read the right way round. */
export function clampToLimit(value: number, limit: JointLimit | undefined): number {
    if (limit === undefined || !limit.enabled) return value;
    const low = Math.min(limit.min, limit.max);
    const high = Math.max(limit.min, limit.max);
    return Math.min(high, Math.max(low, value));
}

/** Everything that decides where a joint puts component 2 relative to joint origin 1. */
export interface JointMotion {
    readonly type: JointType;
    /** Off (default): the two Z axes face each other (faces mate). On: they point the same way. */
    readonly flip: boolean;
    /** Static distance along Z between the origins, mm. */
    readonly offset: number;
    /** Static turn about Z, degrees. */
    readonly angle: number;
    /** DOF values: degrees for rotations, millimetres for translations. */
    readonly rotation: number;
    readonly slide: number;
    readonly slide2: number;
    readonly pitch: number;
    readonly yaw: number;
    readonly rotationLimit?: JointLimit;
    readonly slideLimit?: JointLimit;
}

const DEG = Math.PI / 180;

/**
 * The motion matrix `M` of a joint, in origin 1's frame: a point given in origin 2's frame lands
 * at `M(point)` in origin 1's frame. Applied in this order (the `Matrix4.multiply` convention —
 * `a.multiply(b)` is a, then b): the mate turn (half a turn about Y unless flipped — opposite faces carry opposite X axes and the same Y, see `worldAxisXVec`, so this keeps two mated parts square to each other), the
 * rotations, then the translations. DOF values the type does not have are ignored, and the
 * limited ones are clamped.
 */
export function jointMotionMatrix(motion: JointMotion): Matrix4 {
    const dofs = jointDofs(motion.type);
    const rotation = dofs.rotation ? clampToLimit(motion.rotation, motion.rotationLimit) : 0;
    const slide = dofs.slide ? clampToLimit(motion.slide, motion.slideLimit) : 0;
    const slide2 = dofs.slide2 ? motion.slide2 : 0;
    let result = motion.flip ? Matrix4.identity() : rotationAbout(XYZ.unitY, Math.PI);
    result = result.multiply(rotationAbout(XYZ.unitZ, (motion.angle + rotation) * DEG));
    if (dofs.ball) {
        result = result
            .multiply(rotationAbout(XYZ.unitY, motion.yaw * DEG))
            .multiply(rotationAbout(XYZ.unitX, motion.pitch * DEG));
    }
    const alongZ = motion.type === "slider" || motion.type === "cylindrical";
    const x = alongZ ? 0 : slide;
    const z = motion.offset + (alongZ ? slide : 0);
    return result.multiply(Matrix4.fromTranslation(x, slide2, z));
}

function rotationAbout(axis: XYZ, radians: number): Matrix4 {
    if (Math.abs(radians) < 1e-15) return Matrix4.identity();
    return Matrix4.fromAxisRad(XYZ.zero, axis, radians);
}

/** A joint origin: a point and a right-handed frame on it (`z` is the joint axis). */
export interface JointFrame {
    readonly origin: XYZLike;
    readonly x: XYZLike;
    readonly z: XYZLike;
}

/** The matrix taking frame coordinates into the space the frame is given in. */
export function frameMatrix(frame: JointFrame): Matrix4 {
    const z = new XYZ(frame.z).normalize() ?? XYZ.unitZ;
    // Re-orthogonalise x against z: a stored frame may carry rounding.
    let x = new XYZ(frame.x);
    x = x.sub(z.multiply(x.dot(z))).normalize() ?? perpendicular(z);
    const y = z.cross(x);
    const o = frame.origin;
    return Matrix4.fromArray([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, o.x, o.y, o.z, 1]);
}

/** `frame` carried by `matrix` (a point and two directions). */
export function transformFrame(frame: JointFrame, matrix: Matrix4): JointFrame {
    return {
        origin: matrix.ofPoint(frame.origin),
        x: matrix.ofVector(frame.x).normalize() ?? new XYZ(frame.x),
        z: matrix.ofVector(frame.z).normalize() ?? new XYZ(frame.z),
    };
}

/** Some unit vector perpendicular to `vector`. */
export function perpendicular(vector: XYZ): XYZ {
    const helper = Math.abs(vector.x) < 0.9 ? XYZ.unitX : XYZ.unitY;
    return vector.cross(helper).normalize()!;
}

/**
 * Where component 2 must sit (its world placement) for the joint to hold, given component 1's:
 * `frame2` lands on `M(frame1)`. Frames are in their components' local spaces.
 */
export function placeSecond(world1: Matrix4, frame1: Matrix4, frame2: Matrix4, motion: Matrix4): Matrix4 {
    return invertOrIdentity(frame2).multiply(motion).multiply(frame1).multiply(world1);
}

/** The inverse problem: component 1's world placement from component 2's. */
export function placeFirst(world2: Matrix4, frame1: Matrix4, frame2: Matrix4, motion: Matrix4): Matrix4 {
    return invertOrIdentity(frame1).multiply(invertOrIdentity(motion)).multiply(frame2).multiply(world2);
}

export function invertOrIdentity(matrix: Matrix4): Matrix4 {
    return matrix.invert() ?? Matrix4.identity();
}
