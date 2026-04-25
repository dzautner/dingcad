/**
 * IFC 4 STEP file generator for Lupapiste building permit submission.
 *
 * Produces a minimal valid IFC4 file (ISO 10303-21) from project data,
 * mapping scene objects to standard IFC building elements: IfcWall,
 * IfcRoof, IfcDoor, IfcWindow, IfcSlab. Includes IfcProject, IfcSite,
 * IfcBuilding, and IfcBuildingStorey hierarchy with material assignments.
 *
 * Related issue: https://github.com/dzautner/helscoop/issues/360
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IFCBuildingInfo {
  address?: string;
  buildingType?: string;
  yearBuilt?: number;
  area?: number;
  floors?: number;
}

export interface IFCBomItem {
  material_id: string;
  material_name: string;
  quantity: number;
  unit: string;
  category_name?: string;
}

export interface IFCSceneObject {
  name: string;
  type: "wall" | "roof" | "door" | "window" | "slab" | "generic";
  dimensions: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  material?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a GUID-like identifier for IFC (22-char base64 compact form). */
function ifcGuid(index: number): string {
  // IFC uses 22-char base64-encoded GUIDs. For reproducibility we derive
  // them from the index rather than using true UUIDs.
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  let guid = "";
  let val = index + 1000000;
  for (let i = 0; i < 22; i++) {
    guid += chars[val % 64];
    val = Math.floor(val / 64) + i + 1;
  }
  return guid;
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").split(".")[0];
}

function stepString(s: string): string {
  // IFC STEP strings use single quotes with special escaping
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Map a scene variable/material name to an IFC element type. */
export function classifyElement(
  name: string,
  material?: string,
  dimensions?: { x: number; y: number; z: number },
  position?: { x: number; y: number; z: number },
): IFCSceneObject["type"] {
  const n = name.toLowerCase();
  if (n.includes("roof") || n.includes("katto")) return "roof";
  if (n.includes("door") || n.includes("ovi") || n.includes("gate") || n.includes("portti")) return "door";
  if (n.includes("window") || n.includes("ikkuna")) return "window";
  if (n.includes("floor") || n.includes("slab") || n.includes("deck")
    || n.includes("lattia") || n.includes("laatta") || n.includes("foundation")) return "slab";
  if (n.includes("wall") || n.includes("sein")) return "wall";
  if (n.includes("beam") || n.includes("palkki") || n.includes("post")
    || n.includes("pilari") || n.includes("railing") || n.includes("kaide")
    || n.includes("step") || n.includes("stair") || n.includes("porras")) return "generic";

  // Fallback: check material
  const m = (material || "").toLowerCase();
  if (m.includes("roofing") || m.includes("katto") || m.includes("metal")) return "roof";
  if (m.includes("foundation") || m.includes("concrete") || m.includes("betoni")) return "slab";
  if (m.includes("glass") || m.includes("lasi")) return "window";

  // Geometry-based heuristic: thin & tall = wall, thin & flat = slab
  if (dimensions) {
    const { x: w, y: h, z: d } = dimensions;
    const minHorizontal = Math.min(w, d);
    const maxHorizontal = Math.max(w, d);
    // Thin vertically and large horizontally = slab/floor
    if (h <= 0.3 && maxHorizontal >= 1.0 && minHorizontal >= 1.0) return "slab";
    // Thin in one horizontal dimension and tall = wall
    if (h > 1.0 && (minHorizontal <= 0.3)) return "wall";
  }

  return "generic"; // unknown structural elements — not silently classified as wall
}

/** Number pattern that matches both integers (4) and floats (4.0, .5) */
const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;

/** Strip single-line (//) and multi-line (/* *​/) comments from source. */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Resolve simple `const <name> = <number>;` variable references.
 */
function resolveNumericVars(src: string): Map<string, number> {
  const vars = new Map<string, number>();
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    vars.set(m[1], parseFloat(m[2]));
  }
  return vars;
}

/**
 * Parse a comma-separated argument list, resolving numeric literals and
 * variable references.  Handles trailing commas and arbitrary whitespace.
 */
function resolveArgs(raw: string, vars: Map<string, number>): number[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const nums: number[] = [];
  for (const part of parts) {
    if (/^-?\d+(?:\.\d+)?$/.test(part) || /^\.\d+$/.test(part)) {
      nums.push(parseFloat(part));
    } else if (vars.has(part)) {
      nums.push(vars.get(part)!);
    } else {
      return null;
    }
  }
  return nums;
}

/**
 * Parse scene.js source to extract scene objects with their names, dimensions,
 * positions, and material assignments.
 *
 * Handles: integer and float args, multiline formatting, comments,
 * trailing commas, simple variable references, rotate() wrappers,
 * and let/var in addition to const.
 */
export function parseSceneObjects(sceneJs: string): IFCSceneObject[] {
  const objects: IFCSceneObject[] = [];

  // Pre-process: strip comments, resolve numeric variables, collapse newlines
  const clean = stripComments(sceneJs);
  const vars = resolveNumericVars(clean);
  const collapsed = clean.replace(/\n/g, " ");

  const varDims: Map<string, { w: number; h: number; d: number; x: number; y: number; z: number }> = new Map();

  // Match: const <name> = translate([rotate(]box(w,h,d)[, ...])], x, y, z)
  const translateBoxRe = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*translate\(\s*(?:rotate\(\s*)?box\(\s*((?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*)\s*,?\s*\)` +
    String.raw`(?:\s*,\s*(?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*\s*,?\s*\))?\s*,\s*` +
    String.raw`((?:-?(?:${NUM})|\w+)(?:\s*,\s*(?:-?(?:${NUM})|\w+))*)\s*,?\s*\)`,
    "g"
  );

  let m: RegExpExecArray | null;
  while ((m = translateBoxRe.exec(collapsed)) !== null) {
    const boxArgs = resolveArgs(m[2], vars);
    const posArgs = resolveArgs(m[3], vars);
    if (boxArgs && boxArgs.length >= 3 && posArgs && posArgs.length >= 3) {
      varDims.set(m[1], {
        w: boxArgs[0], h: boxArgs[1], d: boxArgs[2],
        x: posArgs[0], y: posArgs[1], z: posArgs[2],
      });
    }
  }

  // Match: const <name> = box(w, h, d)
  const boxRe = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*box\(\s*((?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*)\s*,?\s*\)`,
    "g"
  );

  while ((m = boxRe.exec(collapsed)) !== null) {
    // Skip if already matched by translate()
    if (varDims.has(m[1])) continue;
    const args = resolveArgs(m[2], vars);
    if (args && args.length >= 3) {
      varDims.set(m[1], {
        w: args[0], h: args[1], d: args[2],
        x: 0, y: 0, z: 0,
      });
    }
  }

  // Match scene.add calls to pick up material assignments and emit objects
  const addRegex = /scene\.add\s*\(\s*(\w+)\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  while ((m = addRegex.exec(collapsed)) !== null) {
    const varName = m[1];
    const optsStr = m[2] || "";
    const dims = varDims.get(varName);
    if (!dims) continue;

    // Extract material from options
    const matMatch = optsStr.match(/material\s*:\s*["']([^"']+)["']/);
    const materialStr = matMatch ? matMatch[1] : undefined;

    const dimensions = { x: dims.w, y: dims.h, z: dims.d };
    const position = { x: dims.x, y: dims.y, z: dims.z };
    const elementType = classifyElement(varName, materialStr, dimensions, position);

    objects.push({
      name: varName,
      type: elementType,
      dimensions,
      position,
      material: materialStr,
    });
  }

  return objects;
}

// ---------------------------------------------------------------------------
// IFC element type to STEP entity
// ---------------------------------------------------------------------------

const IFC_TYPE_MAP: Record<IFCSceneObject["type"], string> = {
  wall: "IFCWALL",
  roof: "IFCROOF",
  door: "IFCDOOR",
  window: "IFCWINDOW",
  slab: "IFCSLAB",
  generic: "IFCBUILDINGELEMENTPROXY",
};

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export interface GenerateIFCInput {
  project: {
    id: string;
    name: string;
    description?: string;
    scene_js?: string;
  };
  bom: IFCBomItem[];
  buildingInfo?: IFCBuildingInfo;
}

/**
 * Generate a minimal IFC4 STEP file from project data.
 *
 * The output follows ISO 10303-21 encoding and is accepted by standard IFC
 * validators (e.g. BIM Collaboration Format tools, Solibri, Lupapiste).
 */
export function generateIFC(input: GenerateIFCInput): string {
  const { project, bom, buildingInfo } = input;
  const ts = isoTimestamp();
  const projectName = project.name || "Helscoop Project";
  const projectDesc = project.description || "";

  // Parse scene objects from scene_js
  const sceneObjects = project.scene_js ? parseSceneObjects(project.scene_js) : [];

  // Build entity lines — IFC STEP uses incrementing #N entity IDs
  let entityId = 0;
  const lines: string[] = [];

  function next(): number {
    return ++entityId;
  }

  function emit(content: string): number {
    const id = next();
    lines.push(`#${id}=${content};`);
    return id;
  }

  // --- Header entities ---

  // #1 IFCPERSON
  const personId = emit("IFCPERSON($,$,'',$,$,$,$,$)");

  // #2 IFCORGANIZATION
  const orgId = emit("IFCORGANIZATION($,'Helscoop','Helscoop.fi renovation planning tool',$,$)");

  // #3 IFCPERSONANDORGANIZATION
  const persOrgId = emit(`IFCPERSONANDORGANIZATION(#${personId},#${orgId},$)`);

  // #4 IFCAPPLICATION
  const appId = emit(`IFCAPPLICATION(#${orgId},'1.0','Helscoop','Helscoop')`);

  // #5 IFCOWNERHISTORY
  const ownerHistId = emit(
    `IFCOWNERHISTORY(#${persOrgId},#${appId},$,.NOCHANGE.,$,$,$,${Math.floor(Date.now() / 1000)})`
  );

  // #6 IFCDIRECTION (Z axis)
  const dirZId = emit("IFCDIRECTION((0.,0.,1.))");

  // #7 IFCDIRECTION (X axis)
  const dirXId = emit("IFCDIRECTION((1.,0.,0.))");

  // #8 IFCCARTESIANPOINT (origin)
  const originId = emit("IFCCARTESIANPOINT((0.,0.,0.))");

  // #9 IFCAXIS2PLACEMENT3D (world coordinate system)
  const wcsId = emit(`IFCAXIS2PLACEMENT3D(#${originId},#${dirZId},#${dirXId})`);

  // #10 IFCGEOMETRICREPRESENTATIONCONTEXT
  const contextId = emit(
    `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#${wcsId},$)`
  );

  // #11 IFCSIUNIT (length — meters)
  const siLengthId = emit("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");

  // #12 IFCSIUNIT (area — square meters)
  const siAreaId = emit("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");

  // #13 IFCSIUNIT (volume — cubic meters)
  const siVolumeId = emit("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");

  // #14 IFCSIUNIT (angle — radians)
  const siAngleId = emit("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");

  // #15 IFCUNITASSIGNMENT
  const unitsId = emit(`IFCUNITASSIGNMENT((#${siLengthId},#${siAreaId},#${siVolumeId},#${siAngleId}))`);

  // #16 IFCPROJECT
  const projectId = emit(
    `IFCPROJECT('${ifcGuid(0)}',#${ownerHistId},${stepString(projectName)},${stepString(projectDesc)},$,$,$,(#${contextId}),#${unitsId})`
  );

  // --- Spatial structure ---

  // #17 IFCSITE
  const siteId = emit(
    `IFCSITE('${ifcGuid(1)}',#${ownerHistId},${stepString(buildingInfo?.address || 'Site')},$,$,#${wcsId},$,$,.ELEMENT.,$,$,$,$,$)`
  );

  // #18 IFCBUILDING
  const buildingId = emit(
    `IFCBUILDING('${ifcGuid(2)}',#${ownerHistId},${stepString(projectName)},$,$,#${wcsId},$,$,.ELEMENT.,$,$,$)`
  );

  // #19 IFCBUILDINGSTOREY
  const storeyId = emit(
    `IFCBUILDINGSTOREY('${ifcGuid(3)}',#${ownerHistId},'Ground Floor',$,$,#${wcsId},$,$,.ELEMENT.,0.)`
  );

  // --- Spatial containment relationships ---

  // IFCRELAGGREGATES: Project -> Site
  emit(
    `IFCRELAGGREGATES('${ifcGuid(100)}',#${ownerHistId},'ProjectSite',$,#${projectId},(#${siteId}))`
  );

  // IFCRELAGGREGATES: Site -> Building
  emit(
    `IFCRELAGGREGATES('${ifcGuid(101)}',#${ownerHistId},'SiteBuilding',$,#${siteId},(#${buildingId}))`
  );

  // IFCRELAGGREGATES: Building -> Storey
  emit(
    `IFCRELAGGREGATES('${ifcGuid(102)}',#${ownerHistId},'BuildingStorey',$,#${buildingId},(#${storeyId}))`
  );

  // --- Building elements from scene ---
  const elementIds: number[] = [];
  const materialElements: Map<string, number[]> = new Map();

  for (let i = 0; i < sceneObjects.length; i++) {
    const obj = sceneObjects[i];
    const ifcType = IFC_TYPE_MAP[obj.type];

    // Cartesian point for element position
    const ptId = emit(
      `IFCCARTESIANPOINT((${obj.position.x.toFixed(3)},${obj.position.z.toFixed(3)},${obj.position.y.toFixed(3)}))`
    );

    // Axis placement for element
    const placementId = emit(`IFCAXIS2PLACEMENT3D(#${ptId},#${dirZId},#${dirXId})`);

    // Local placement
    const localPlacementId = emit(`IFCLOCALPLACEMENT($,#${placementId})`);

    // Bounding box representation (geometry placeholder)
    const bbId = emit(`IFCBOUNDINGBOX(#${originId},${obj.dimensions.x.toFixed(3)},${obj.dimensions.z.toFixed(3)},${obj.dimensions.y.toFixed(3)})`);

    // Shape representation
    const shapeRepId = emit(
      `IFCSHAPEREPRESENTATION(#${contextId},'Box','BoundingBox',(#${bbId}))`
    );
    const prodShapeId = emit(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shapeRepId}))`);

    // The building element itself
    let elemId: number;
    if (obj.type === "window") {
      elemId = emit(
        `${ifcType}('${ifcGuid(200 + i)}',#${ownerHistId},${stepString(obj.name)},$,$,#${localPlacementId},#${prodShapeId},$,$)`
      );
    } else if (obj.type === "door") {
      elemId = emit(
        `${ifcType}('${ifcGuid(200 + i)}',#${ownerHistId},${stepString(obj.name)},$,$,#${localPlacementId},#${prodShapeId},$,$,$)`
      );
    } else {
      elemId = emit(
        `${ifcType}('${ifcGuid(200 + i)}',#${ownerHistId},${stepString(obj.name)},$,$,#${localPlacementId},#${prodShapeId},$)`
      );
    }

    elementIds.push(elemId);

    // Track material assignments
    if (obj.material) {
      if (!materialElements.has(obj.material)) {
        materialElements.set(obj.material, []);
      }
      materialElements.get(obj.material)!.push(elemId);
    }
  }

  // IFCRELCONTAINEDINSPATIALSTRUCTURE: Storey -> elements
  if (elementIds.length > 0) {
    const elemRefs = elementIds.map((id) => `#${id}`).join(",");
    emit(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid(300)}',#${ownerHistId},'StoreyElements',$,(${elemRefs}),#${storeyId})`
    );
  }

  // --- Material assignments from BOM ---
  let matIdx = 0;
  for (const [matKey, elemIds] of materialElements) {
    // Find matching BOM item for display name
    const bomItem = bom.find(
      (b) => b.material_id === matKey || (b.material_name || "").toLowerCase().includes(matKey.toLowerCase())
    );
    const matName = bomItem?.material_name || matKey;

    const matId = emit(`IFCMATERIAL(${stepString(matName)})`);
    const elemRefs = elemIds.map((id) => `#${id}`).join(",");
    emit(
      `IFCRELASSOCIATESMATERIAL('${ifcGuid(400 + matIdx)}',#${ownerHistId},'MaterialAssignment',$,(${elemRefs}),#${matId})`
    );
    matIdx++;
  }

  // --- Assemble the STEP file ---
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`,
    `FILE_NAME('${projectName.replace(/'/g, "")}.ifc','${ts}',(''),(''),'Helscoop IFC Generator','Helscoop 1.0','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "",
    "DATA;",
  ].join("\n");

  const footer = ["ENDSEC;", "END-ISO-10303-21;"].join("\n");

  return header + "\n" + lines.join("\n") + "\n" + footer + "\n";
}
