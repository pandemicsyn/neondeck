import { defineAction, type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import {
  listRuntimeSkills,
  loadRuntimeSkill,
  reloadRuntimeSkills,
  skillLoadInputSchema,
  type LoadedRuntimeSkill,
  type RuntimeSkillInventory,
} from './skills';

type RuntimeSkillActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  skills?: JsonValue[];
  skill?: JsonValue;
  roots?: JsonValue[];
  duplicates?: JsonValue[];
  ignored?: JsonValue[];
  errors?: string[];
  requires?: string[];
};

const runtimeSkillActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  roots: v.optional(v.array(v.unknown())),
  skills: v.optional(v.array(v.unknown())),
  skill: v.optional(v.unknown()),
  duplicates: v.optional(v.array(v.unknown())),
  ignored: v.optional(v.array(v.unknown())),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});

export const skillsListAction = defineAction({
  name: 'neondeck_skills_list',
  description:
    'List discovered Neondeck runtime skills, ignored skill folders, and duplicate skill ids.',
  input: v.object({}),
  output: runtimeSkillActionOutputSchema,
  async run() {
    return listRuntimeSkillsAction();
  },
});

export const skillLoadAction = defineAction({
  name: 'neondeck_skill_load',
  description:
    'Load the full SKILL.md content for one active Neondeck runtime skill by id.',
  input: skillLoadInputSchema,
  output: runtimeSkillActionOutputSchema,
  async run({ input }) {
    return loadRuntimeSkillAction(input);
  },
});

export const skillsReloadAction = defineAction({
  name: 'neondeck_skills_reload',
  description:
    'Rescan Neondeck runtime skill metadata from disk and report validation issues. Agent behavior uses Flue skills and may require a new session or server restart.',
  input: v.object({}),
  output: runtimeSkillActionOutputSchema,
  async run() {
    return reloadRuntimeSkillsAction();
  },
});

export const neondeckRuntimeSkillActions = [
  skillsListAction,
  skillLoadAction,
  skillsReloadAction,
];

async function listRuntimeSkillsAction(
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const inventory = await listRuntimeSkills(paths);
  return okResult('skills_list', 'Listed runtime skills.', inventory);
}

async function loadRuntimeSkillAction(
  input: v.InferInput<typeof skillLoadInputSchema>,
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const result = await loadRuntimeSkill(input, paths);
  if (!result.ok) {
    return {
      ok: false,
      action: 'skill_load',
      changed: false,
      message: result.error,
      ...(result.requires ? { requires: result.requires } : {}),
      ...(result.issues ? { errors: result.issues } : {}),
      ...(result.inventory
        ? {
            skills: result.inventory.skills.map(asJsonValue),
            duplicates: result.inventory.duplicates.map(asJsonValue),
            ignored: result.inventory.ignored.map(asJsonValue),
          }
        : {}),
    };
  }

  return okResult('skill_load', `Loaded runtime skill "${result.skill.id}".`, {
    ...result.inventory,
    skills: result.inventory.skills,
    skill: result.skill,
  });
}

async function reloadRuntimeSkillsAction(
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const inventory = await reloadRuntimeSkills(paths);
  return okResult('skills_reload', 'Reloaded runtime skills.', inventory);
}

function okResult(
  action: string,
  message: string,
  inventory: RuntimeSkillInventory & { skill?: LoadedRuntimeSkill },
): RuntimeSkillActionResult {
  return {
    ok: true,
    action,
    changed: false,
    message,
    roots: inventory.roots.map(asJsonValue),
    skills: inventory.skills.map(asJsonValue),
    duplicates: inventory.duplicates.map(asJsonValue),
    ignored: inventory.ignored.map(asJsonValue),
    ...(inventory.skill ? { skill: asJsonValue(inventory.skill) } : {}),
  };
}
