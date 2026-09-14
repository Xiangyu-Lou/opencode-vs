import { describe, expect, test } from "bun:test"
import { errorOf, isConflict } from "./errors"

// The generated client rejects with an Error whose `cause` carries the parsed body and the status; the routes'
// declared fields exist only there.
function thrown(body: unknown, status: number) {
  return new Error(
    typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : "failed",
    { cause: { body, status } },
  )
}

describe("errorOf", () => {
  test("reads the declared fields out of the cause", () => {
    const error = thrown(
      {
        name: "VsWorkerConflictError",
        file: "/config/opencode.json",
        expected: "a",
        actual: "b",
        message: "changed on disk",
      },
      409,
    )
    expect(errorOf(error)).toEqual({
      name: "VsWorkerConflictError",
      file: "/config/opencode.json",
      message: "changed on disk",
      status: 409,
    })
  })

  test("falls back to the Error message when the body carries none", () => {
    expect(errorOf(new Error("boom")).message).toBe("boom")
  })

  test("survives values that are not errors at all", () => {
    expect(errorOf(undefined)).toEqual({})
    expect(errorOf("nope")).toEqual({})
    expect(errorOf(new Error("x", { cause: "not a record" }))).toMatchObject({ message: "x" })
  })

  test("reads a body delivered directly rather than through a cause", () => {
    expect(errorOf({ body: { name: "VsWorkerNotFoundError", message: "gone" } })).toMatchObject({
      name: "VsWorkerNotFoundError",
      message: "gone",
    })
  })
})

describe("isConflict", () => {
  test("recognises the declared error name", () => {
    expect(isConflict(thrown({ name: "VsWorkerConflictError", message: "x" }, 409))).toBe(true)
  })

  test("recognises a bare 409 with no declared name", () => {
    expect(isConflict(thrown({ message: "x" }, 409))).toBe(true)
  })

  test("does not treat other failures as conflicts", () => {
    expect(isConflict(thrown({ name: "VsWorkerInvalidError", message: "x" }, 400))).toBe(false)
    expect(isConflict(new Error("offline"))).toBe(false)
  })
})
