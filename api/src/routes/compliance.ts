/**
 * Compliance check API route.
 *
 * POST /compliance/check — validates a scene against Finnish building code rules.
 * Does not require authentication so it can be used from the editor preview
 * and shared project views.
 */

import { Router } from "express";

// ---------------------------------------------------------------------------
// Inline compliance checker — mirrors web/src/lib/compliance.ts
//
// We duplicate the pure logic here instead of sharing a package so the API
// stays self-contained and deployable without a monorepo build step.
// ---------------------------------------------------------------------------

export interface ComplianceWarning {
  ruleId: string;
  severity: "error" | "warning" | "info";
  messageKey: string;
  params: Record<string, string | number>;
  affectedMesh?: string;
}

interface BuildingInfo {
  type?: string;
  year?: number;
}

interface ParsedMesh {
  name: string;
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  material?: string;
  isSubtract?: boolean;
}

/** Number pattern that matches both integers (4) and floats (4.0, .5) */
const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;

/** Strip single-line (//) and multi-line (/* *​/) comments from source. */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Resolve simple `const <name> = <number>;` variable references to their
 * numeric values.  Returns a map of variable name -> number for use in
 * argument resolution.
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
 * variable references.  Handles trailing commas and arbitrary whitespace
 * (including newlines).
 */
function resolveArgs(raw: string, vars: Map<string, number>): number[] | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const nums: number[] = [];
  for (const part of parts) {
    if (/^-?\d+(?:\.\d+)?$/.test(part) || /^\.\d+$/.test(part)) {
      nums.push(parseFloat(part));
    } else if (vars.has(part)) {
      nums.push(vars.get(part)!);
    } else {
      return null; // Unresolvable argument
    }
  }
  return nums;
}

export interface ParseWarning {
  type: "unresolved_geometry";
  message: string;
  line?: number;
}

function parseMeshes(sceneJs: string, parseWarnings?: ParseWarning[]): ParsedMesh[] {
  const meshes: ParsedMesh[] = [];
  const meshMap = new Map<string, ParsedMesh>();

  // Pre-process: strip comments and resolve numeric variables
  const clean = stripComments(sceneJs);
  const vars = resolveNumericVars(clean);

  // Collapse newlines so multi-line expressions become single-line for regex
  const collapsed = clean.replace(/\n/g, " ");

  // --- Match box(...) ---
  const boxRe = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*box\(\s*((?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*)\s*,?\s*\)`,
    "g"
  );
  let m: RegExpExecArray | null;

  while ((m = boxRe.exec(collapsed)) !== null) {
    const args = resolveArgs(m[2], vars);
    if (!args || args.length < 3) {
      if (parseWarnings) {
        parseWarnings.push({
          type: "unresolved_geometry",
          message: `Could not resolve arguments for box() assigned to '${m[1]}'`,
        });
      }
      continue;
    }
    const mesh: ParsedMesh = {
      name: m[1],
      w: args[0],
      h: args[1],
      d: args[2],
      x: 0, y: 0, z: 0,
    };
    meshMap.set(mesh.name, mesh);
    meshes.push(mesh);
  }

  // --- Match translate(box(...), x, y, z) and translate(rotate(box(...), ...), x, y, z) ---
  const translateBoxRe = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*translate\(\s*(?:rotate\(\s*)?box\(\s*((?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*)\s*,?\s*\)` +
    String.raw`(?:\s*,\s*(?:${NUM}|\w+)(?:\s*,\s*(?:${NUM}|\w+))*\s*,?\s*\))?\s*,\s*` +
    String.raw`((?:-?(?:${NUM})|\w+)(?:\s*,\s*(?:-?(?:${NUM})|\w+))*)\s*,?\s*\)`,
    "g"
  );

  while ((m = translateBoxRe.exec(collapsed)) !== null) {
    const boxArgs = resolveArgs(m[2], vars);
    const posArgs = resolveArgs(m[3], vars);
    if (!boxArgs || boxArgs.length < 3 || !posArgs || posArgs.length < 3) {
      if (parseWarnings) {
        parseWarnings.push({
          type: "unresolved_geometry",
          message: `Could not resolve arguments for translate(box()) assigned to '${m[1]}'`,
        });
      }
      continue;
    }
    const mesh: ParsedMesh = {
      name: m[1],
      w: boxArgs[0],
      h: boxArgs[1],
      d: boxArgs[2],
      x: posArgs[0],
      y: posArgs[1],
      z: posArgs[2],
    };
    meshMap.set(mesh.name, mesh);
    meshes.push(mesh);
  }

  // --- Catch-all: detect any box() or translate(box()) that we failed to parse ---
  // This generates warnings for geometry we could see but couldn't resolve.
  const anyBoxRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:translate\s*\(\s*(?:rotate\s*\(\s*)?)?box\s*\([^)]*\)/g;
  while ((m = anyBoxRe.exec(collapsed)) !== null) {
    const varName = m[1];
    if (!meshMap.has(varName) && parseWarnings) {
      parseWarnings.push({
        type: "unresolved_geometry",
        message: `Could not resolve arguments for box() assigned to '${varName}'`,
      });
    }
  }

  // --- Match subtract(a, b) to mark cutters ---
  const subtractRe = /(?:const|let|var)\s+(\w+)\s*=\s*subtract\(\s*(\w+)\s*,\s*(\w+)\s*\)/g;

  while ((m = subtractRe.exec(collapsed)) !== null) {
    const cutterName = m[3];
    const cutter = meshMap.get(cutterName);
    if (cutter) {
      cutter.isSubtract = true;
    }
  }

  // --- Match scene.add() for material assignments ---
  const addRe = /scene\.add\(\s*(\w+)\s*,\s*\{[^}]*material:\s*["']([^"']+)["'][^}]*\}/g;

  while ((m = addRe.exec(collapsed)) !== null) {
    const meshRef = meshMap.get(m[1]);
    if (meshRef) {
      meshRef.material = m[2];
    }
  }

  return meshes;
}

function checkMinCeilingHeight(meshes: ParsedMesh[], buildingInfo?: BuildingInfo): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];
  const MIN_HEIGHT_M = 2.5;

  const isResidential =
    !buildingInfo?.type ||
    ["omakotitalo", "rivitalo", "paritalo"].includes(buildingInfo.type);

  if (!isResidential) return warnings;

  const walls = meshes.filter(
    (m) => !m.isSubtract && m.h > 1.5 && (m.w <= 0.3 || m.d <= 0.3)
  );

  for (const wall of walls) {
    const heightMm = Math.round(wall.h * 1000);
    if (wall.h < MIN_HEIGHT_M) {
      warnings.push({
        ruleId: "FI-RakMK-G1-2.1",
        severity: "error",
        messageKey: "compliance.minCeilingHeight",
        params: { height: heightMm },
        affectedMesh: wall.name,
      });
    }
  }

  return warnings;
}

function checkMinDoorWidth(meshes: ParsedMesh[]): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];
  const MIN_DOOR_WIDTH_M = 0.8;

  const doors = meshes.filter((m) => m.isSubtract && m.h >= 1.8);

  for (const door of doors) {
    const width = door.w > door.d ? door.w : door.d;
    const widthMm = Math.round(width * 1000);

    if (width < MIN_DOOR_WIDTH_M) {
      warnings.push({
        ruleId: "FI-RakMK-F1-2.3",
        severity: "error",
        messageKey: "compliance.minDoorWidth",
        params: { width: widthMm },
        affectedMesh: door.name,
      });
    }
  }

  return warnings;
}

function checkHandrailRequired(meshes: ParsedMesh[]): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];
  const HANDRAIL_THRESHOLD_M = 0.5;

  const platforms = meshes.filter(
    (m) => !m.isSubtract && m.h <= 0.3 && m.y > HANDRAIL_THRESHOLD_M && m.w >= 1.0 && m.d >= 1.0
  );

  const posts = meshes.filter(
    (m) => !m.isSubtract && m.h >= 0.8 && m.w <= 0.2 && m.d <= 0.2
  );

  for (const platform of platforms) {
    const elevationMm = Math.round(platform.y * 1000);

    const hasPosts = posts.some((post) => {
      const dx = Math.abs(post.x - platform.x);
      const dz = Math.abs(post.z - platform.z);
      return dx <= platform.w / 2 + 0.3 && dz <= platform.d / 2 + 0.3;
    });

    if (!hasPosts) {
      warnings.push({
        ruleId: "FI-RakMK-F2-3.2",
        severity: "warning",
        messageKey: "compliance.handrailRequired",
        params: { elevation: elevationMm },
        affectedMesh: platform.name,
      });
    }
  }

  return warnings;
}

function checkMaxBuildingHeight(meshes: ParsedMesh[]): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];
  const MAX_HEIGHT_M = 12.0;

  let maxTop = 0;
  let highestMesh = "";

  for (const mesh of meshes) {
    if (mesh.isSubtract) continue;
    const top = mesh.y + mesh.h / 2;
    if (top > maxTop) {
      maxTop = top;
      highestMesh = mesh.name;
    }
  }

  if (maxTop > MAX_HEIGHT_M) {
    const heightMm = Math.round(maxTop * 1000);
    warnings.push({
      ruleId: "FI-MRL-115",
      severity: "error",
      messageKey: "compliance.maxBuildingHeight",
      params: { height: heightMm, limit: MAX_HEIGHT_M * 1000 },
      affectedMesh: highestMesh,
    });
  }

  return warnings;
}

function checkMinRoomArea(meshes: ParsedMesh[]): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];
  const MIN_AREA_M2 = 7.0;

  const floors = meshes.filter(
    (m) => !m.isSubtract && m.h <= 0.3 && m.y <= 0.5 && m.w >= 1.0 && m.d >= 1.0
  );

  for (const floor of floors) {
    const area = floor.w * floor.d;
    const areaSqm = Math.round(area * 10) / 10;

    if (area < MIN_AREA_M2) {
      warnings.push({
        ruleId: "FI-RakMK-G1-2.2",
        severity: "warning",
        messageKey: "compliance.minRoomArea",
        params: { area: areaSqm, limit: MIN_AREA_M2 },
        affectedMesh: floor.name,
      });
    }
  }

  return warnings;
}

const ALL_RULES = [
  { id: "FI-RakMK-G1-2.1", check: checkMinCeilingHeight },
  { id: "FI-RakMK-F1-2.3", check: checkMinDoorWidth },
  { id: "FI-RakMK-F2-3.2", check: checkHandrailRequired },
  { id: "FI-MRL-115", check: checkMaxBuildingHeight },
  { id: "FI-RakMK-G1-2.2", check: checkMinRoomArea },
] as const;

const RULE_COUNT = ALL_RULES.length;

export function checkCompliance(
  sceneJs: string,
  buildingInfo?: BuildingInfo
): { warnings: ComplianceWarning[]; parseWarnings: ParseWarning[] } {
  const parseWarnings: ParseWarning[] = [];

  if (!sceneJs || sceneJs.trim().length === 0) {
    return { warnings: [], parseWarnings };
  }

  const meshes = parseMeshes(sceneJs, parseWarnings);
  if (meshes.length === 0) {
    return { warnings: [], parseWarnings };
  }

  const warnings: ComplianceWarning[] = [];
  for (const rule of ALL_RULES) {
    warnings.push(...rule.check(meshes, buildingInfo));
  }
  return { warnings, parseWarnings };
}

// ---------------------------------------------------------------------------
// Express Router
// ---------------------------------------------------------------------------

const router = Router();

router.post("/check", (req, res) => {
  const { sceneJs, buildingInfo } = req.body;

  if (!sceneJs || typeof sceneJs !== "string") {
    return res.status(400).json({ error: "sceneJs is required and must be a string" });
  }

  // Cap input size to prevent regex DoS
  if (sceneJs.length > 500_000) {
    return res.status(400).json({ error: "sceneJs exceeds maximum allowed size (500 KB)" });
  }

  const { warnings, parseWarnings } = checkCompliance(sceneJs, buildingInfo);

  const failedRuleIds = new Set(warnings.map((w) => w.ruleId));
  const passedRules = RULE_COUNT - failedRuleIds.size;

  res.json({
    warnings,
    parseWarnings,
    checkedRules: RULE_COUNT,
    passedRules,
  });
});

export default router;
