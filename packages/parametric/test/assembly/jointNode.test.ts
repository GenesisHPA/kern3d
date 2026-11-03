// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AssemblyComponentNode, FolderNode, Transaction } from "@chili3d/core";
import { TestDocument, TestNode } from "@chili3d/core/test-utils";
import { componentCandidates, createComponent } from "../../src/assembly/componentCommands";
import { primaryDof, sweepRange, sweepValue } from "../../src/assembly/jointCommands";
import { JOINT_TYPE_KEYS } from "../../src/assembly/jointMath";
import { JointNode } from "../../src/assembly/jointNode";

function joint(type: ConstructorParameters<typeof JointNode>[0]["jointType"] = "revolute") {
    return new JointNode({ document: new TestDocument(), name: "J", jointType: type });
}

describe("JointNode", () => {
    test("a DOF the type does not have reads undefined, so its row is hidden", () => {
        const slider = joint("slider");
        expect(slider.rotation).toBeUndefined();
        expect(slider.slide).toBe(0);
        expect(slider.rotationLimited).toBeUndefined();
        expect(slider.slideLimited).toBe(false);
        const ball = joint("ball");
        expect(ball.pitch).toBe(0);
        expect(ball.rotationLimited).toBeUndefined();
    });

    test("limit rows appear with their toggle, and a value set past a limit is held at it", () => {
        const revolute = joint();
        expect(revolute.rotationMin).toBeUndefined();
        revolute.rotationLimited = true;
        revolute.rotationMin = -30;
        revolute.rotationMax = 60;
        revolute.rotation = 100;
        expect(revolute.rotation).toBe(60);
        revolute.rotation = -100;
        expect(revolute.rotation).toBe(-30);
    });

    test("the type dropdown maps keys to the stored type", () => {
        const node = joint("rigid");
        node.typeKey = JOINT_TYPE_KEYS.planar;
        expect(node.jointType).toBe("planar");
        expect(node.slide2).toBe(0);
    });

    test("a non-number edit is refused", () => {
        const node = joint();
        node.offset = Number.NaN;
        expect(node.offset).toBe(0);
    });

    test("the solver's state drives the warning badge", () => {
        const node = joint();
        const changed: string[] = [];
        node.onPropertyChanged((p) => changed.push(p as string));
        expect(node.warningCount).toBe(0);
        node.setSolveState("conflict", false);
        expect(node.warningCount).toBe(1);
        expect(node.warningTooltip).toBe("assembly.joint.status.conflict");
        expect(changed).toContain("warningCount");
        node.setSolveState("ok", true);
        expect(node.warningTooltip).toBe("assembly.joint.status.originLost");
    });
});

describe("drive", () => {
    test("drives the rotation where there is one, else the slide; a rigid joint has nothing", () => {
        expect(primaryDof(joint("cylindrical"))).toBe("rotation");
        expect(primaryDof(joint("slider"))).toBe("slide");
        expect(primaryDof(joint("rigid"))).toBeUndefined();
    });

    test("sweeps between the limits, or a full turn without them", () => {
        const node = joint();
        expect(sweepRange(node, "rotation", 10)).toEqual([10, 370]);
        node.rotationLimited = true;
        node.rotationMin = 90;
        node.rotationMax = -90;
        expect(sweepRange(node, "rotation", 0)).toEqual([-90, 90]);
        expect(sweepValue([0, 100], 0)).toBe(0);
        expect(sweepValue([0, 100], 2)).toBe(100);
        expect(sweepValue([0, 100], 3)).toBe(50);
    });
});

describe("New Component", () => {
    test("takes the selection's top-level nodes, never a body's consumed tool", () => {
        const doc = new TestDocument();
        const folder = new FolderNode({ document: doc, name: "F" });
        const a = new TestNode("a");
        const b = new TestNode("b");
        doc.modelManager.rootNode.add(folder, b);
        folder.add(a);
        expect(componentCandidates([folder, a, b])).toEqual([folder, b]);
    });

    test("moves the nodes into a new component in their place, as one undo step", () => {
        const doc = new TestDocument();
        const a = new TestNode("a");
        const b = new TestNode("b");
        const c = new TestNode("c");
        doc.modelManager.rootNode.add(a, b, c);
        let component!: AssemblyComponentNode;
        Transaction.execute(doc, "component", () => {
            component = createComponent(doc, [b, c]);
        });
        expect(doc.modelManager.rootNode.firstChild).toBe(a);
        expect(a.nextSibling).toBe(component);
        expect(component.firstChild).toBe(b);
        expect(b.nextSibling).toBe(c);
        doc.history.undo();
        expect(b.parent).toBe(doc.modelManager.rootNode);
        expect(component.parent).toBeUndefined();
    });
});
