// The few parts of clipper-lib (Angus Johnson's Clipper 6, JS port) the CAM uses.
declare module "clipper-lib" {
    interface IntPoint {
        X: number;
        Y: number;
    }
    type Path = IntPoint[];
    type Paths = Path[];
    class ClipperOffset {
        constructor(miterLimit?: number, arcTolerance?: number);
        AddPaths(paths: Paths, joinType: number, endType: number): void;
        Execute(solution: Paths, delta: number): void;
        Clear(): void;
    }
    class Clipper {
        AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
        Execute(clipType: number, solution: Paths, subjFill: number, clipFill: number): boolean;
        static Orientation(path: Path): boolean;
        static Area(path: Path): number;
        static SimplifyPolygons(paths: Paths, fillType: number): Paths;
    }
    const JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
    const EndType: { etClosedPolygon: number; etClosedLine: number; etOpenRound: number; etOpenButt: number };
    const ClipType: { ctIntersection: number; ctUnion: number; ctDifference: number; ctXor: number };
    const PolyType: { ptSubject: number; ptClip: number };
    const PolyFillType: { pftEvenOdd: number; pftNonZero: number };
    const ClipperLib: {
        ClipperOffset: typeof ClipperOffset;
        Clipper: typeof Clipper;
        JoinType: typeof JoinType;
        EndType: typeof EndType;
        ClipType: typeof ClipType;
        PolyType: typeof PolyType;
        PolyFillType: typeof PolyFillType;
    };
    export default ClipperLib;
}
