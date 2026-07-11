import { describe, expect, test } from "bun:test";
import {
  bulkUpdateExamTestsSchema,
  createExamTestSchema,
} from "../exams.validation";

describe("exam test config validation", () => {
  test("rejects invalid numeric threshold strings", () => {
    const result = createExamTestSchema.safeParse({
      name: "CBC",
      productId: 1,
      referenceLow: "abc",
    });

    expect(result.success).toBe(false);
  });

  test("rejects inverted reference and critical ranges", () => {
    const reference = createExamTestSchema.safeParse({
      name: "CBC",
      productId: 1,
      testType: "NUMERIC",
      referenceLow: 10,
      referenceHigh: 5,
    });
    const critical = createExamTestSchema.safeParse({
      name: "CBC",
      productId: 1,
      testType: "NUMERIC",
      referenceLow: 3,
      referenceHigh: 8,
      criticalLow: 4,
      criticalHigh: 7,
    });

    expect(reference.success).toBe(false);
    expect(critical.success).toBe(false);
  });

  test("rejects qualitative tests with numeric bounds", () => {
    const result = createExamTestSchema.safeParse({
      name: "HIV rapid test",
      productId: 1,
      testType: "QUALITATIVE",
      referenceLow: 1,
    });

    expect(result.success).toBe(false);
  });

  test("parses valid bulk numeric thresholds and allows null clears", () => {
    const result = bulkUpdateExamTestsSchema.safeParse({
      tests: [
        {
          id: 1,
          testType: "NUMERIC",
          referenceLow: "1.2",
          referenceHigh: "3.4",
          criticalLow: null,
          criticalHigh: "",
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.tests[0].referenceLow).toBe(1.2);
    expect(result.data.tests[0].criticalLow).toBeNull();
    expect(result.data.tests[0].criticalHigh).toBeNull();
  });
});
