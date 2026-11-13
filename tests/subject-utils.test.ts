import { describe, expect, it } from "vitest";
import { isCoreSubjectName } from "../src/academics/subject-utils";

describe("isCoreSubjectName", () => {
  it.each([
    ["English Language", true],
    ["  ENGLISH   Language ", true],
    ["Maths", true],
    ["Mathematics", true],
    ["Integrated Science", true],
    ["Social Studies", true],
    ["Science", true],
    ["Science and Technology", true],
    ["History", false],
    ["Computing", false],
    ["RME", false],
    ["French", false],
    ["Creative Arts", false],
  ])("matches %s as core=%s", (name, expected) => {
    expect(isCoreSubjectName(name)).toBe(expected);
  });
});
