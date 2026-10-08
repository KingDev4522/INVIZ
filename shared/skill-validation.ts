/**
 * Skill contract validation — REAL (Phase 1).
 * Validates skill metadata, procedure steps, and ensures skills use only
 * existing INVIZ action types. No arbitrary code execution.
 */

import {
  type ActionType,
  type ExpectationType,
  type Skill,
  type SkillValidationResult,
  ACTION_TYPES,
  EXPECTATION_TYPES,
} from "./types.js";

export function validateSkill(skill: unknown): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(skill)) {
    return { valid: false, errors: ["skill must be an object"], warnings: [] };
  }

  // --- Identity validation ---
  const id = skill["id"];
  if (typeof id !== "string" || id.trim() === "") {
    errors.push("id: required non-empty string");
  } else if (!/^[a-z0-9_]+$/.test(id)) {
    errors.push("id: must be lowercase alphanumeric with underscores only");
  }

  const namespace = skill["namespace"];
  if (typeof namespace !== "string" || namespace.trim() === "") {
    errors.push("namespace: required non-empty string");
  }

  const name = skill["name"];
  if (typeof name !== "string" || name.trim() === "") {
    errors.push("name: required non-empty string");
  }

  const version = skill["version"];
  if (typeof version !== "string" || version.trim() === "") {
    errors.push("version: required non-empty string");
  } else if (!isValidSemVer(version)) {
    errors.push(`version: "${version}" is not valid SemVer`);
  }

  // --- Description validation ---
  const description = skill["description"];
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("description: required non-empty string");
  } else if (description.length > 1000) {
    errors.push("description: exceeds 1000 characters");
  }

  const supportedIntents = skill["supportedIntents"];
  if (!Array.isArray(supportedIntents)) {
    errors.push("supportedIntents: must be an array");
  } else {
    for (let i = 0; i < supportedIntents.length; i++) {
      const intent = supportedIntents[i];
      if (typeof intent !== "string" || intent.trim() === "") {
        errors.push(`supportedIntents[${i}]: must be non-empty string`);
      }
    }
  }

  const examples = skill["examples"];
  if (!Array.isArray(examples)) {
    errors.push("examples: must be an array");
  } else if (examples.length === 0) {
    warnings.push("examples: skill has no usage examples");
  } else {
    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      if (typeof example !== "string" || example.trim() === "") {
        errors.push(`examples[${i}]: must be non-empty string`);
      }
    }
  }

  // --- Status validation ---
  const status = skill["status"];
  if (!isValidSkillStatus(status)) {
    errors.push(`status: "${status}" must be one of: candidate, tested, approved, canary, trusted, disabled`);
  }

  const testStatus = skill["testStatus"];
  if (!isValidTestStatus(testStatus)) {
    errors.push(`testStatus: "${testStatus}" must be one of: untested, passing, failing`);
  }

  // --- Timestamp validation ---
  const createdAt = skill["createdAt"];
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt) || createdAt < 0) {
    errors.push("createdAt: must be a non-negative integer");
  }

  const modifiedAt = skill["modifiedAt"];
  if (typeof modifiedAt !== "number" || !Number.isInteger(modifiedAt) || modifiedAt < 0) {
    errors.push("modifiedAt: must be a non-negative integer");
  } else if (typeof createdAt === "number" && modifiedAt < createdAt) {
    errors.push("modifiedAt: must be >= createdAt");
  }

  const createdBy = skill["createdBy"];
  if (typeof createdBy !== "string" || createdBy.trim() === "") {
    errors.push("createdBy: required non-empty string");
  }

  // --- Inputs validation ---
  validateRequiredInputs(skill["requiredInputs"], errors);
  validateRequiredCapabilities(skill["requiredCapabilities"], errors);

  // --- Procedure validation (CRITICAL: must use only existing ActionTypes) ---
  validateProcedure(skill["procedure"], errors, warnings);

  // --- Verification criteria validation ---
  validateVerificationCriteria(skill["verificationCriteria"], errors, warnings);

  // --- Recovery strategies validation ---
  validateRecoveryStrategies(skill["recoveryStrategies"], errors, warnings);

  // --- Testing validation ---
  const testFilePaths = skill["testFilePaths"];
  if (!Array.isArray(testFilePaths)) {
    errors.push("testFilePaths: must be an array");
  } else {
    for (let i = 0; i < testFilePaths.length; i++) {
      const path = testFilePaths[i];
      if (typeof path !== "string" || path.trim() === "") {
        errors.push(`testFilePaths[${i}]: must be non-empty string`);
      }
    }
  }

  const lastTestedAt = skill["lastTestedAt"];
  if (lastTestedAt !== null && typeof lastTestedAt !== "number") {
    errors.push("lastTestedAt: must be null or a number");
  }

  const lastTestResult = skill["lastTestResult"];
  if (lastTestResult !== null && typeof lastTestResult !== "string") {
    errors.push("lastTestResult: must be null or a string");
  }

  // --- Rollout validation ---
  const canaryRolloutPercent = skill["canaryRolloutPercent"];
  if (typeof canaryRolloutPercent !== "number" || !Number.isInteger(canaryRolloutPercent) || canaryRolloutPercent < 0 || canaryRolloutPercent > 100) {
    errors.push("canaryRolloutPercent: must be an integer 0-100");
  }

  const canaryStartedAt = skill["canaryStartedAt"];
  if (canaryStartedAt !== null && typeof canaryStartedAt !== "number") {
    errors.push("canaryStartedAt: must be null or a number");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateRequiredInputs(
  inputs: unknown,
  errors: string[],
): void {
  if (!Array.isArray(inputs)) {
    errors.push("requiredInputs: must be an array");
    return;
  }
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!isRecord(input)) {
      errors.push(`requiredInputs[${i}]: must be an object`);
      continue;
    }
    const name = input["name"];
    if (typeof name !== "string" || name.trim() === "") {
      errors.push(`requiredInputs[${i}].name: required non-empty string`);
    }
    const description = input["description"];
    if (typeof description !== "string" || description.trim() === "") {
      errors.push(`requiredInputs[${i}].description: required non-empty string`);
    }
    const required = input["required"];
    if (typeof required !== "boolean") {
      errors.push(`requiredInputs[${i}].required: must be boolean`);
    }
  }
}

function validateRequiredCapabilities(
  capabilities: unknown,
  errors: string[],
): void {
  if (!Array.isArray(capabilities)) {
    errors.push("requiredCapabilities: must be an array");
    return;
  }
  const validCapabilities = [
    "read_page",
    "find_element",
    "click",
    "type",
    "focus",
    "select",
    "scroll",
    "press_key",
    "navigate",
    "wait",
    "verify",
  ] as const;
  for (let i = 0; i < capabilities.length; i++) {
    const cap = capabilities[i];
    if (
      typeof cap !== "string" ||
      !(validCapabilities as readonly string[]).includes(cap)
    ) {
      errors.push(`requiredCapabilities[${i}]: "${cap}" is not a valid capability`);
    }
  }
}

function validateProcedure(
  procedure: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (!Array.isArray(procedure)) {
    errors.push("procedure: must be an array");
    return;
  }
  if (procedure.length === 0) {
    errors.push("procedure: must have at least one step");
    return;
  }

  for (let i = 0; i < procedure.length; i++) {
    const step = procedure[i];
    const prefix = `procedure[${i}]`;

    if (!isRecord(step)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const description = step["description"];
    if (typeof description !== "string" || description.trim() === "") {
      errors.push(`${prefix}.description: required non-empty string`);
    }

    const action = step["action"];
    if (typeof action !== "string") {
      errors.push(`${prefix}.action: must be a string`);
    } else if (!ACTION_TYPES.includes(action as ActionType)) {
      // CRITICAL: Skills MUST NOT introduce new action types
      errors.push(
        `${prefix}.action: "${action}" is not a valid ActionType. ` +
        `Skills must use existing INVIZ actions only — no new browser actions.`
      );
    }

    const target = step["target"];
    if (target !== undefined) {
      if (typeof target !== "string") {
        errors.push(`${prefix}.target: must be a string`);
      } else if (!isValidElementId(target) && !isValidRegionId(target)) {
        errors.push(
          `${prefix}.target: "${target}" must match eNN (element) or rNN (region) format`
        );
      }
    }

    const value = step["value"];
    if (value !== undefined && typeof value !== "string") {
      errors.push(`${prefix}.value: must be a string`);
    }

    const parameters = step["parameters"];
    if (parameters !== undefined && !isRecord(parameters)) {
      errors.push(`${prefix}.parameters: must be an object`);
    }

    const expect = step["expect"];
    if (expect !== undefined) {
      if (!isRecord(expect)) {
        errors.push(`${prefix}.expect: must be an object`);
      } else {
        const expectResult = validateExpectationMinimal(expect, `${prefix}.expect`);
        if (!expectResult.valid) {
          errors.push(...expectResult.errors);
        }
      }
    }

    const waitFor = step["waitFor"];
    if (waitFor !== undefined && typeof waitFor !== "string") {
      errors.push(`${prefix}.waitFor: must be a string`);
    } else if (waitFor !== undefined && !isValidWaitCondition(waitFor)) {
      errors.push(
        `${prefix}.waitFor: "${waitFor}" must be one of: navigation, element_present, element_absent, text_present, field_filled, element_state, dialog_present, stable`
      );
    }

    const maxAttempts = step["maxAttempts"];
    if (maxAttempts !== undefined) {
      if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        errors.push(`${prefix}.maxAttempts: must be an integer 1-10`);
      }
    }
  }
}

function validateVerificationCriteria(
  criteria: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (!Array.isArray(criteria)) {
    errors.push("verificationCriteria: must be an array");
    return;
  }
  if (criteria.length === 0) {
    warnings.push("verificationCriteria: skill has no verification criteria");
    return;
  }

  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i];
    const prefix = `verificationCriteria[${i}]`;

    if (!isRecord(criterion)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const description = criterion["description"];
    if (typeof description !== "string" || description.trim() === "") {
      errors.push(`${prefix}.description: required non-empty string`);
    }

    const type = criterion["type"];
    if (typeof type !== "string") {
      errors.push(`${prefix}.type: must be a string`);
    } else if (!EXPECTATION_TYPES.includes(type as ExpectationType)) {
      errors.push(
        `${prefix}.type: "${type}" is not a valid ExpectationType`
      );
    }

    const target = criterion["target"];
    if (target !== undefined) {
      if (typeof target !== "string") {
        errors.push(`${prefix}.target: must be a string`);
      } else if (!isValidElementId(target) && !isValidRegionId(target)) {
        errors.push(
          `${prefix}.target: "${target}" must match eNN or rNN format`
        );
      }
    }

    const value = criterion["value"];
    if (value !== undefined && typeof value !== "string") {
      errors.push(`${prefix}.value: must be a string`);
    }

    const state = criterion["state"];
    if (state !== undefined) {
      if (typeof state !== "string") {
        errors.push(`${prefix}.state: must be a string`);
      } else if (!["checked", "expanded", "selected", "pressed"].includes(state)) {
        errors.push(
          `${prefix}.state: "${state}" must be one of: checked, expanded, selected, pressed`
        );
      }
    }

    const stateValue = criterion["stateValue"];
    if (stateValue !== undefined && typeof stateValue !== "boolean") {
      errors.push(`${prefix}.stateValue: must be a boolean`);
    }
  }
}

function validateRecoveryStrategies(
  strategies: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (!Array.isArray(strategies)) {
    errors.push("recoveryStrategies: must be an array");
    return;
  }

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const prefix = `recoveryStrategies[${i}]`;

    if (!isRecord(strategy)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const trigger = strategy["trigger"];
    if (typeof trigger !== "string") {
      errors.push(`${prefix}.trigger: must be a string`);
    } else if (!isValidRecoveryTrigger(trigger)) {
      errors.push(
        `${prefix}.trigger: "${trigger}" must be one of: element_not_found, action_failed, verification_failed, navigation_failed, timeout, unexpected_state`
      );
    }

    const action = strategy["action"];
    if (typeof action !== "string" || action.trim() === "") {
      errors.push(`${prefix}.action: required non-empty string`);
    }

    const maxAttempts = strategy["maxAttempts"];
    if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      errors.push(`${prefix}.maxAttempts: must be an integer 1-5`);
    }

    const escalateOnExhaustion = strategy["escalateOnExhaustion"];
    if (typeof escalateOnExhaustion !== "boolean") {
      errors.push(`${prefix}.escalateOnExhaustion: must be boolean`);
    }
  }
}

// --- Helper validation functions ---

function isValidSemVer(version: string): boolean {
  // Basic SemVer check: MAJOR.MINOR.PATCH
  const semVerRegex = /^\d+\.\d+\.\d+$/;
  return semVerRegex.test(version);
}

function isValidSkillStatus(
  status: unknown,
): status is "candidate" | "tested" | "approved" | "canary" | "trusted" | "disabled" {
  return [
    "candidate",
    "tested",
    "approved",
    "canary",
    "trusted",
    "disabled",
  ].includes(status as string);
}

function isValidTestStatus(status: unknown): status is "untested" | "passing" | "failing" {
  return ["untested", "passing", "failing"].includes(status as string);
}

function isValidElementId(id: string): boolean {
  return /^e\d+$/.test(id);
}

function isValidRegionId(id: string): boolean {
  return /^r\d+$/.test(id);
}

function isValidWaitCondition(condition: string): boolean {
  return [
    "navigation",
    "element_present",
    "element_absent",
    "text_present",
    "field_filled",
    "element_state",
    "dialog_present",
    "stable",
  ].includes(condition);
}

function isValidRecoveryTrigger(trigger: string): boolean {
  return [
    "element_not_found",
    "action_failed",
    "verification_failed",
    "navigation_failed",
    "timeout",
    "unexpected_state",
  ].includes(trigger);
}

function validateExpectationMinimal(
  expect: unknown,
  path: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(expect)) {
    errors.push(`${path}: must be an object`);
    return { valid: false, errors };
  }

  const type = expect["type"];
  if (typeof type !== "string") {
    errors.push(`${path}.type: required string`);
    return { valid: false, errors };
  }
  if (!EXPECTATION_TYPES.includes(type as ExpectationType)) {
    errors.push(`${path}.type: "${type}" is not a valid ExpectationType`);
  }

  // Minimal validation - full validation happens in validateStructuredAction
  return { valid: errors.length === 0, errors };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates that a skill procedure step's action is an existing ActionType.
 * This is the critical security check that prevents skills from introducing
 * arbitrary browser actions.
 */
export function validateSkillActionType(action: unknown): boolean {
  if (typeof action !== "string") return false;
  return ACTION_TYPES.includes(action as ActionType);
}

/**
 * Trust-qualified statuses: past the candidate gate but not disabled.
 *
 * This is a NECESSARY-not-sufficient check. The authoritative execution gate is
 * the registry's execution policy (see SkillRegistry.isExecutable), which can
 * additionally withhold `tested`/`canary` until policy explicitly allows them.
 * "candidate" skills MUST NOT execute automatically.
 */
export function isSkillExecutable(status: Skill["status"]): boolean {
  return (
    status === "tested" ||
    status === "approved" ||
    status === "canary" ||
    status === "trusted"
  );
}

/**
 * Checks if a skill is in a candidate state (not yet approved for execution).
 */
export function isSkillCandidate(status: Skill["status"]): boolean {
  return status === "candidate";
}
