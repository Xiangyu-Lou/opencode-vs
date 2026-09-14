export * as VsWorkerSkillFiles from "./skill-files"

import fs from "fs/promises"
import path from "path"
import { ConfigMarkdown } from "@/config/markdown"
import { Filesystem } from "@/util/filesystem"

// Skill names become directory names, so they are validated the same way the rest of the ecosystem names
// skills: lowercase words joined by single hyphens, and nothing that could escape the directory.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_NAME = 64

export class InvalidNameError extends Error {
  readonly skill: string
  constructor(skill: string) {
    super(`invalid skill name: ${skill}`)
    this.skill = skill
  }
}

export class ExistsError extends Error {
  constructor(readonly location: string) {
    super(`a skill already exists at ${location}`)
  }
}

export class MissingError extends Error {
  readonly skill: string
  constructor(skill: string) {
    super(`no editable skill named ${skill}`)
    this.skill = skill
  }
}

export function validName(name: string): boolean {
  if (name !== name.trim()) return false
  if (name.length === 0 || name.length > MAX_NAME) return false
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false
  if (name === "." || name === "..") return false
  return NAME.test(name)
}

export function assertName(name: string) {
  if (!validName(name)) throw new InvalidNameError(name)
  return name
}

export function dir(root: string, name: string) {
  const target = path.join(root, assertName(name))
  // Belt and braces: even with a validated name, never write outside the root we were handed.
  if (path.dirname(target) !== path.resolve(root)) throw new InvalidNameError(name)
  return target
}

export function location(root: string, name: string) {
  return path.join(dir(root, name), "SKILL.md")
}

// YAML frontmatter with the two fields the skill loader reads. Values are quoted and escaped so a description
// containing a colon or a quote round-trips.
export function render(input: { name: string; description?: string; content: string }) {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  const lines = ["---", `name: ${quote(input.name)}`]
  if (input.description) lines.push(`description: ${quote(input.description)}`)
  lines.push("---", "")
  const body = input.content.replace(/^﻿/, "").trimStart()
  return `${lines.join("\n")}\n${body}${body.endsWith("\n") ? "" : "\n"}`
}

export const TEMPLATE = `## When to use

Describe the situations where this skill applies.

## Instructions

1. First step
2. Second step

## Examples

Show a short worked example.
`

export async function create(input: { root: string; name: string; description?: string; content?: string }) {
  const file = location(input.root, input.name)
  if (await Filesystem.exists(file)) throw new ExistsError(file)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Filesystem.write(
    file,
    render({ name: input.name, description: input.description, content: input.content ?? TEMPLATE }),
  )
  return file
}

export async function update(input: { root: string; name: string; description?: string; content: string }) {
  const file = location(input.root, input.name)
  if (!(await Filesystem.exists(file))) throw new MissingError(input.name)
  await Filesystem.write(file, render({ name: input.name, description: input.description, content: input.content }))
  return file
}

export async function remove(input: { root: string; name: string }) {
  const target = dir(input.root, input.name)
  if (!(await Filesystem.exists(path.join(target, "SKILL.md")))) throw new MissingError(input.name)
  await fs.rm(target, { recursive: true, force: true })
  return target
}

// Reads a SKILL.md back into the pieces the editor needs: frontmatter description plus the body without it.
export async function read(file: string) {
  const parsed = await ConfigMarkdown.parse(file)
  const data = parsed.data as { name?: unknown; description?: unknown }
  return {
    name: typeof data?.name === "string" ? data.name : path.basename(path.dirname(file)),
    description: typeof data?.description === "string" ? data.description : undefined,
    content: parsed.content,
  }
}
